
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const db = require("./db");

// active trivia channels and sessions tracking to prevent concurrent games
const activeTriviaChannels = new Set();
const activeSessions = new Map(); // sessionId -> { channelId, messageIds, timestamp, participants }

// =====================
// Slash Commands
// =====================
const commands = [
  {
    name: "trivia",
    description: "Start a trivia quiz event",
  },
  {
    name: "purge-quiz",
    description: "Remove all messages from a specific quiz session",
    options: [
      {
        name: "session",
        description: "Session ID to purge (format: timestamp-channelId)",
        type: 3, // has to be a STRING
        required: true,
      },
    ],
  },
  {
    name: "list-sessions",
    description: "List all active quiz sessions in this server",
  },
];

// =====================
// Session Management
// =====================
function generateSessionId(channelId) {
  const timestamp = Date.now();
  return `${timestamp}-${channelId}`;
}

async function cleanupSession(client, log, sessionId) {
  // Defensive check
  if (!sessionId || typeof sessionId !== 'string') {
    log("warn", "cleanup", "Invalid sessionId provided to cleanupSession", { sessionId });
    return;
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    log("warn", "cleanup", `Session ${sessionId} not found for cleanup`);
    return;
  }

  try {
    const channel = client.channels.cache.get(session.channelId);
    if (channel && Array.isArray(session.messageIds)) {
      // Delete all messages from this session
      for (const messageId of session.messageIds) {
        try {
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message) {
            await message.delete();
          }
        } catch (err) {
          log("warn", "cleanup", `Failed to delete message ${messageId}`, err);
        }
      }
    }
    
    activeSessions.delete(sessionId);
    if (session.channelId) {
      activeTriviaChannels.delete(session.channelId);
    }
    log("info", "cleanup", `Session ${sessionId} cleaned up successfully`);
  } catch (err) {
    log("error", "cleanup", `Failed to cleanup session ${sessionId}`, err);
    // Ensure we still remove from tracking even if cleanup partially fails
    activeSessions.delete(sessionId);
    if (session?.channelId) {
      activeTriviaChannels.delete(session.channelId);
    }
  }
}

// =====================
// Trivia Game Logic
// =====================
async function startTrivia(client, log, interaction, category, timeLimit) {
  // Defensive checks
  if (!interaction || !interaction.channel) {
    log("error", "validation", "Invalid interaction or channel in startTrivia");
    return;
  }

  const channel = interaction.channel;
  const channelId = channel.id;
  
  // Validate parameters
  if (!category || typeof category !== 'string' || category.trim().length === 0) {
    log("error", "validation", "Invalid category parameter", { category });
    try {
      await interaction.followUp({
        content: "⚠️ Invalid category provided.",
        ephemeral: true,
      });
    } catch (err) {
      log("error", "validation", "Failed to send invalid category message", err);
    }
    return;
  }

  if (!Number.isInteger(timeLimit) || timeLimit < 5 || timeLimit > 300) {
    log("error", "validation", "Invalid timeLimit parameter", { timeLimit });
    try {
      await interaction.followUp({
        content: "⚠️ Invalid time limit. Must be between 5 and 300 seconds.",
        ephemeral: true,
      });
    } catch (err) {
      log("error", "validation", "Failed to send invalid timeLimit message", err);
    }
    return;
  }

  const sessionId = generateSessionId(channelId);
  
  // Safety check in case of race conditions - use atomic check-and-set pattern
  if (activeTriviaChannels.has(channelId)) {
    log("warn", "validation", "Trivia already running in channel", { channelId, sessionId });
    try {
      await interaction.followUp({
        content: "⚠️ A trivia game is already running in this channel. Please wait for it to finish.",
        ephemeral: true,
      });
    } catch (err) {
      log("error", "validation", "Failed to send already running message", err);
    }
    return;
  }

  // Add to active channels immediately to prevent race conditions
  activeTriviaChannels.add(channelId);
  log("info", "game-start", `Starting trivia in category: ${category}, time: ${timeLimit}s`, { sessionId });

  // Initialize session tracking here
  const session = {
    channelId: channel.id,
    messageIds: [],
    timestamp: Date.now(),
    participants: new Set(),
    category,
    timeLimit,
    currentQuestion: 0,
    totalQuestions: 0
  };
  activeSessions.set(sessionId, session);

  try {
    // we try fetching 10 random questions from the db
    const result = db.getQuestionsByCategoryRobust(category, 10);
    const quizQuestions = result.questions || [];

    log("info", "db-lookup", "Category lookup attempts", { sessionId, requested: category, resolved: result.resolvedCategory, method: result.method, attempts: result.attempts });

    if (quizQuestions.length === 0) {
      // error handling
      const distinct = db.getDistinctCategories().slice(0, 10);
      const suggestionLines = distinct.map(c => `• ${c.category} (${c.count})`).join("\n");
      const diagnostics = [
        `Requested: ${category}`,
        `Tried methods: ${result.attempts.map(a => a.method + (a.token ? `(${a.token})` : '')).join(', ') || 'none'}`,
        `Top categories in DB:\n${suggestionLines || 'No categories found in DB.'}`
      ].join('\n');

      const errorMsg = await channel.send(
        `⚠️ No questions found for category: **${category}**\n\nDiagnostics:\n${diagnostics}`
      );
      session.messageIds.push(errorMsg.id);
      log("warn", "game-start", `No questions found in DB for ${category}`, { sessionId });
      
      // Cleanup session if it can't start - use proper error handling
      setTimeout(() => {
        try {
          cleanupSession(client, log, sessionId).catch(err => {
            log("error", "cleanup", `Failed to cleanup failed session ${sessionId}`, err);
          });
        } catch (err) {
          log("error", "cleanup", `Error in cleanup timer for failed session ${sessionId}`, err);
        }
      }, 10000);
      return;
    }

    // Update session with the resolved category if different
    if (result.resolvedCategory && result.resolvedCategory !== category) {
      session.category = result.resolvedCategory;
      log("info", "db-lookup", "Resolved category differs from requested", { sessionId, requested: category, resolved: result.resolvedCategory, method: result.method });
    }

    session.totalQuestions = quizQuestions.length;
    const leaderboard = {};
    const questionAnswers = new Map(); // track who answered each question

    // Send session info
    const sessionInfoEmbed = new EmbedBuilder()
      .setTitle("🎮 Trivia Session Started!")
      .setDescription(`**Category (requested):** ${category}\n**Questions:** ${quizQuestions.length}\n**Time per question:** ${timeLimit} seconds\n**Session ID:** \`${sessionId}\``)
      .setColor("Green")
      .setTimestamp();

    const sessionMsg = await channel.send({ embeds: [sessionInfoEmbed] });
    session.messageIds.push(sessionMsg.id);

    for (let i = 0; i < quizQuestions.length; i++) {
      session.currentQuestion = i + 1;
      const q = quizQuestions[i];
      const options = [q.option1, q.option2, q.option3, q.option4];

      log("info", "question", `Presenting question ${i + 1}/${quizQuestions.length}` , { 
        sessionId, 
        questionId: q.id 
      });

      const embed = new EmbedBuilder()
        .setTitle(`Question ${i + 1} of ${quizQuestions.length}`)
        .setDescription(q.question)
        .addFields(
          options.map((opt, idx) => ({
            name: `${["*", "*", "*", "*"][idx]} Answer ${idx + 1}`,
            value: opt,
            inline: true,
          }))
        )
        .setFooter({ text: `Category: ${q.category} | Time: ${timeLimit}s` })
        .setColor("Blue")
        .setTimestamp();

      // Create buttons instead of reactions
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`answer_${sessionId}_${i}_0`)          
          .setStyle(ButtonStyle.Primary)
          .setEmoji(":Marker1_Icon:1417258336084033656:"),
        new ButtonBuilder()
          .setCustomId(`answer_${sessionId}_${i}_1`)          
          .setStyle(ButtonStyle.Primary)
          .setEmoji(":Marker2_Icon:1417258353129685022:"),
        new ButtonBuilder()
          .setCustomId(`answer_${sessionId}_${i}_2`)          
          .setStyle(ButtonStyle.Primary)
          .setEmoji(":Marker3_Icon:1417258368896073879:"),
        new ButtonBuilder()
          .setCustomId(`answer_${sessionId}_${i}_3`)          
          .setStyle(ButtonStyle.Primary)
          .setEmoji(":Marker4_Icon:1417258399325753414:")
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });
      session.messageIds.push(msg.id);

      // answer tracking
      const questionKey = `${sessionId}_${i}`;
      questionAnswers.set(questionKey, new Set());

      
      const collector = msg.createMessageComponentCollector({
        componentType: 2, // BUTTON. I got bamboozled by discord.js docs initially
        time: timeLimit * 1000,
      });

      collector.on("collect", async (buttonInteraction) => {
        try {
          const userId = buttonInteraction.user.id;
          const customIdParts = buttonInteraction.customId.split("_");
          const selectedAnswerStr = customIdParts[customIdParts.length - 1];
          const selectedAnswer = Number(selectedAnswerStr);

          if (!Number.isInteger(selectedAnswer) || selectedAnswer < 0 || selectedAnswer > 3) {
            await buttonInteraction.reply({
              content: "❌ Invalid answer selection received.",
              ephemeral: true,
            }).catch(() => {});
            log("warn", "answer", "Received invalid selectedAnswer index", { customId: buttonInteraction.customId, selectedAnswerStr });
            return;
          }

          // Check if user already answered this question
          if (questionAnswers.get(questionKey).has(userId)) {
            await buttonInteraction.reply({
              content: "❌ You have already answered this question!",
              ephemeral: true,
            });
            return;
          }

          
          questionAnswers.get(questionKey).add(userId);
          session.participants.add(userId);

          if (!leaderboard[userId]) {
            leaderboard[userId] = { score: 0, name: buttonInteraction.user.username };
          }

          if (selectedAnswer === q.correct_index) {
            leaderboard[userId].score++;
            log("info", "answer", `${buttonInteraction.user.username} got question ${i + 1} correct`, {
              sessionId,
              userId,
              selectedAnswer,
              correctAnswer: q.correct_index
            });
            
            await buttonInteraction.reply({
              content: `✅ Correct Answer! +1 point.`,
              ephemeral: true,
            });
          } else {
            log("info", "answer", `${buttonInteraction.user.username} got question ${i + 1} wrong`, {
              sessionId,
              userId,
              selectedAnswer,
              correctAnswer: q.correct_index
            });
            
            await buttonInteraction.reply({
              content: `❌ Sorry! The correct answer was **${options[q.correct_index]}**`,
              ephemeral: true,
            });
          }
        } catch (err) {
          log("error", "answer", "Failed to process button interaction", err);
          try {
            if (!buttonInteraction.replied && !buttonInteraction.deferred) {
              await buttonInteraction.reply({
                content: "❌ Something went wrong processing your answer.",
                ephemeral: true,
              });
            }
          } catch (replyErr) {
            log("error", "answer", "Failed to send error reply", replyErr);
          }
        }
      });

      collector.on("end", () => {
        // Disable all buttons
        const disabledRow = new ActionRowBuilder().addComponents(
          row.components.map(button => ButtonBuilder.from(button).setDisabled(true))
        );
        
        msg.edit({ embeds: [embed], components: [disabledRow] }).catch(err => {
          log("warn", "question", "Failed to disable buttons after timeout", err);
        });
        
        log("info", "question", `Question ${i + 1} time expired`, { sessionId });
      });

      // Wait for the question to complete
      await new Promise((resolve) => collector.on("end", resolve));

      // Small delay between questions
      if (i < quizQuestions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    //  leaderboard
    const sorted = Object.values(leaderboard).sort((a, b) => b.score - a.score);
    const winners = sorted.slice(0, 3);

    const lbEmbed = new EmbedBuilder()
      .setTitle("🏆 Trivia Leaderboard")
      .setDescription(
        winners.length > 0
          ? winners
              .map((w, i) => `${['🥇', '🥈', '🥉'][i] || '🏅'} **${w.name}** - ${w.score}/${quizQuestions.length} points`)
              .join("\n")
          : "No participants this time!"
      )
      .addFields({
        name: "Session Info",
        value: `**Session ID:** \`${sessionId}\`\n**Participants:** ${session.participants.size}\n**Category:** ${category}`,
        inline: false,
      })
      .setColor("Gold")
      .setTimestamp();

    const leaderboardMsg = await channel.send({ embeds: [lbEmbed] });
    session.messageIds.push(leaderboardMsg.id);
    
    log("info", "game-end", "Trivia completed successfully", { 
      sessionId, 
      participants: session.participants.size,
      winners: winners.length 
    });

    // Auto-cleanup after 1 hour. we can manually cleanup anyways, but it avoids channel clutter
    setTimeout(() => {
      try {
        if (activeSessions.has(sessionId)) {
          log("info", "auto-cleanup", `Auto-cleaning session ${sessionId} after 1 hour`);
          cleanupSession(client, log, sessionId).catch(err => {
            log("error", "auto-cleanup", `Failed to auto-cleanup session ${sessionId}`, err);
          });
        }
      } catch (err) {
        log("error", "auto-cleanup", `Error in auto-cleanup timer for session ${sessionId}`, err);
      }
    }, 60 * 60 * 1000);

  } catch (err) {
    log("error", "game", "Trivia game crashed", { sessionId, error: err });
    
    try {
      const errorMsg = await channel.send("⚠️ Something went wrong while running trivia. The session has been terminated.");
      session.messageIds.push(errorMsg.id);
    } catch (sendErr) {
      log("error", "game", "Failed to send error message", sendErr);
    }
    
    // Cleanup on error
    try {
      await cleanupSession(client, log, sessionId);
    } catch (cleanupErr) {
      log("error", "cleanup", `Failed to cleanup session after error ${sessionId}`, cleanupErr);
    }
  } finally {
    // Always remove from active channels to prevent deadlock
    activeTriviaChannels.delete(channelId);
    log("info", "game", `Cleared active state for channel ${channelId}`, { sessionId });
  }
}


// slash commands handler
async function handleTriviaInteraction(client, log, interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "trivia") {
        log("info", "command", "/trivia invoked", { 
          user: interaction.user.username, 
          channelId: interaction.channelId 
        });

        if (activeTriviaChannels.has(interaction.channelId)) {
          await interaction.reply({
            content: "⚠️ A trivia game is already running in this channel. Please wait for it to finish.",
            ephemeral: true,
          });
          return;
        }

        
        const categoryRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("trivia_category")
            .setPlaceholder("Choose a trivia category")
            .addOptions([
              { label: "Movies", value: "Entertainment: Film" },
              { label: "Music", value: "Entertainment: Music" },
              { label: "Television", value: "Entertainment: Television" },
              { label: "Video Games", value: "Entertainment: Video Games" },
              { label: "Anime & Manga", value: "Entertainment: Japanese Anime & Manga" },
            ])
        );

        await interaction.reply({
          content: "🎮 **Let's start a trivia game!** Pick a category:",
          components: [categoryRow],
          ephemeral: true,
        });
      }
      
      else if (interaction.commandName === "purge-quiz") {
        const sessionId = interaction.options.getString("session");
        log("info", "command", "/purge-quiz invoked", { 
          user: interaction.user.username, 
          sessionId 
        });

        if (!activeSessions.has(sessionId)) {
          await interaction.reply({
            content: `❌ Session \`${sessionId}\` not found or already cleaned up.`,
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        
        try {
          await cleanupSession(client, log, sessionId);
          await interaction.editReply({
            content: `✅ Successfully purged all messages from session \`${sessionId}\`.`,
          });
        } catch (err) {
          log("error", "purge", "Failed to purge session", { sessionId, error: err });
          await interaction.editReply({
            content: `❌ Failed to purge session \`${sessionId}\`. Some messages may not have been deleted.`,
          });
        }
      }
      
      else if (interaction.commandName === "list-sessions") {
        log("info", "command", "/list-sessions invoked", { 
          user: interaction.user.username 
        });

        if (activeSessions.size === 0) {
          await interaction.reply({
            content: "📋 No active quiz sessions found.",
            ephemeral: true,
          });
          return;
        }

        const sessionList = Array.from(activeSessions.entries())
          .map(([sessionId, session]) => {
            const timestamp = new Date(session.timestamp).toLocaleString();
            const progress = session.currentQuestion > 0 ? 
              `${session.currentQuestion}/${session.totalQuestions}` : 
              "Starting...";
            return `• **${sessionId}**\n  ⏰ Started: ${timestamp}\n  📍 Channel: <#${session.channelId}>\n  📚 Category: ${session.category}\n  📊 Progress: ${progress}\n  👥 Participants: ${session.participants.size}`;
          })
          .join("\n\n");

        const embed = new EmbedBuilder()
          .setTitle("📋 Active Quiz Sessions")
          .setDescription(sessionList)
          .setColor("Blue")
          .setTimestamp();

        await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }
    }

    // menu interaction handlers
    else if (interaction.isStringSelectMenu()) {
      // first category then time
      if (interaction.customId === "trivia_category") {
        // don't start 2 games at once
        if (activeTriviaChannels.has(interaction.channelId)) {
          await interaction.update({
            content: "⚠️ A trivia game just started in this channel. Please wait for it to finish before starting another.",
            components: [],
          });
          return;
        }

        const category = interaction.values[0];
        log("info", "selection", "Category selected", {
          user: interaction.user.username,
          category,
        });

        const timeRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`trivia_time_${category}`)
            .setPlaceholder("Choose time per question")
            .addOptions([
              { label: "⚡ Fast (10 seconds)", value: "10", description: "Quick-fire questions" },
              { label: "⏱️ Normal (30 seconds)", value: "30", description: "Standard pace" },
              { label: "🕐 Relaxed (60 seconds)", value: "60", description: "Take your time" },
            ])
        );

        await interaction.update({
          content: `📚 **Category:** ${category}\n\n⏰ **Now choose the time limit per question:**`,
          components: [timeRow],
        });
      } 
      
      else if (interaction.customId.startsWith("trivia_time_")) {
        const category = interaction.customId.replace("trivia_time_", "");
        const timeLimit = parseInt(interaction.values[0]);

        log("info", "selection", "Time limit selected", {
          user: interaction.user.username,
          category,
          timeLimit,
        });

        if (activeTriviaChannels.has(interaction.channelId)) {
          await interaction.update({
            content: "⚠️ A trivia game just started in this channel. Please wait for it to finish before starting another.",
            components: [],
          });
          return;
        }

        await interaction.update({
          content: `🎮 Starting trivia...\n**Category:** ${category}\n**Time per question:** ${timeLimit} seconds`,
          components: [],
        });

        // Start trivia asynchronously - don't await to prevent blocking
        startTrivia(client, log, interaction, category, timeLimit).catch(err => {
          log("error", "game", "Trivia startup failed", err);
        });
      } else {
        // avoid silent failure -> interaction failed message
        log("warn", "interaction", "Unhandled select menu", { customId: interaction.customId });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "⚠️ Unknown selection.", ephemeral: true }).catch(() => {});
        }
      }
    }

    
    else if (interaction.isButton() && interaction.customId.startsWith("answer_")) {
      // Collector in startTrivia handles these
    }

  } catch (err) {
    log("error", "interaction", "Failed during interaction handling", err);
    
    try {
      const errorMessage = "❌ Something went wrong processing your request.";
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      } else if (interaction.deferred) {
        await interaction.editReply({ content: errorMessage });
      } else {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      }
    } catch (replyErr) {
      log("error", "interaction", "Failed to send error message", replyErr);
    }
  }
}

// Export functions and data
module.exports = {
  commands,
  handleTriviaInteraction,
  activeTriviaChannels,
  activeSessions,
  cleanupSession
};
