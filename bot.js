const { Client, GatewayIntentBits, ActivityType, SlashCommandBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

// Import trivia module
const triviaModule = require('./quizz');

// Configuration
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS; 
const EVENT_CHANNEL_ID = process.env.EVENT_CHANNEL_ID;
const AUTHORIZED_ROLE_ID = process.env.SERVER_ROLE_ID;
const FARM_ROLE_ID = process.env.FARM_ROLE_ID; 
const WELC_CH_ID = process.env.WELC_CH_ID;
const FC_MEMBER_ROLE_ID = process.env.FC_MEMBER_ROLE_ID || '1236396084046069791';
const NON_FC_MEMBER_ROLE_ID = process.env.NON_FC_MEMBER_ROLE_ID || '1249832281682743367';
const ADMIN_ROLE_IDS = process.env.ADMIN_ROLE_IDS;
const FFXIV_FC_URL = 'https://eu.finalfantasyxiv.com/lodestone/freecompany/9279667032196922298/member';
const FC_CACHE_KEY = 'fc_members_cache';
const FC_CACHE_EXPIRY = 24 * 60 * 60; // 24 hours in seconds 
//redis connection info & logging
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  lazyConnect: true,
  maxRetriesPerRequest : null,
});
redis.on('connect', () => {
  log('Redis connection established successfully', 'INFO');
});
redis.on('error', (err) => {
  log(`Redis connection error: ${err.message}`, 'ERROR');
});
redis.on('ready', () => {
  log('Redis server is ready and operational', 'INFO');
});

// BullMQ Queue for reminders
const reminderQueue = new Queue('event-reminders', { connection: redis });


// Redis management functions
async function saveEventToRedis(event) {
  await redis.hset('events', event.id, JSON.stringify(event));
}

async function getEventFromRedis(eventId) {
  const data = await redis.hget('events', eventId);
  return data ? JSON.parse(data) : null;
}

async function deleteEventFromRedis(eventId) {
  await redis.hdel('events', eventId);
}

// DM message tracking functions
async function saveDMMessageForEvent(eventId, userId, messageId, messageType) {
  const dmKey = `dm_messages:${eventId}`;
  const dmData = {
    userId,
    messageId,
    messageType, // 'registration', 'withdrawal', 'role_change', 'cancellation', 'reminder', 'time_change'
    timestamp: Date.now()
  };
  await redis.hset(dmKey, `${userId}_${messageType}_${Date.now()}`, JSON.stringify(dmData));
  log(`Tracked DM message ${messageId} for user ${userId} in event ${eventId} (type: ${messageType})`, 'DEBUG');
}

async function getDMMessagesForEvent(eventId) {
  const dmKey = `dm_messages:${eventId}`;
  const dmMessages = await redis.hgetall(dmKey);
  return Object.values(dmMessages).map(data => JSON.parse(data));
}

async function deleteDMMessagesForEvent(eventId) {
  const dmKey = `dm_messages:${eventId}`;
  await redis.del(dmKey);
  log(`Deleted DM tracking data for event ${eventId}`, 'DEBUG');
}

// Prune DMs for completed events
async function pruneDMsForCompletedEvent(eventId, event) {
  const dmMessages = await getDMMessagesForEvent(eventId);
  const currentTime = Date.now();
  const eventTime = new Date(event.date).getTime();
  
  // Only prune DMs if the event has already happened
  if (eventTime > currentTime) {
    log(`Event ${eventId} is still upcoming, skipping DM pruning`, 'DEBUG');
    return;
  }
  
  log(`Pruning DMs for completed event ${eventId}. Found ${dmMessages.length} DM messages to process`, 'DEBUG');
  
  // Process each DM message for pruning
  const prunePromises = dmMessages.map(async (dmData) => {
    try {
      const { userId, messageId, messageType } = dmData;
      
      // Only prune specific types of DMs for completed events
      // Keep role_change messages as they might still be relevant
      const typesToPrune = ['registration', 'withdrawal', 'cancellation', 'reminder', 'time_change'];
      
      if (!typesToPrune.includes(messageType)) {
        log(`Keeping ${messageType} DM message for user ${userId} in event ${eventId}`, 'DEBUG');
        return;
      }

      const user = await client.users.fetch(userId);
      if (!user) {
        log(`Could not fetch user ${userId} for DM cleanup`, 'DEBUG');
        return;
      }

      // Try to fetch and delete the DM message
      const dmChannel = await user.createDM();
      try {
        const message = await dmChannel.messages.fetch(messageId);
        await message.delete();
        log(`Deleted ${messageType} DM message ${messageId} for user ${userId} in completed event ${eventId}`, 'DEBUG');
      } catch (e) {
        // Message might already be deleted or not found, that's okay
        log(`Could not delete DM message ${messageId} for user ${userId}: ${e.message}`, 'DEBUG');
      }
    } catch (error) {
      log(`Error processing DM message for user ${dmData.userId}: ${error.message}`, 'DEBUG');
    }
  });

  // Process all DM cleanup operations in parallel
  await Promise.allSettled(prunePromises);
  
  // Clean up the tracking data
  await deleteDMMessagesForEvent(eventId);
}

// FFXIV FC Member Management Functions
async function fetchFCMembers() {
  try {
    log('Fetching FC members from lodestone...', 'INFO');

    const MAX_PAGES = 15; // safety upper bound
    let page = 1;
    const members = {};
    let totalFound = 0;

    // Helper to process a single page's HTML
    const processPage = (html, pageNumber) => {
      const $ = cheerio.load(html);
      let pageCount = 0;

      // New structure: each member entry is an <a class="entry__bg" href="/lodestone/character/ID/"> ... <p class="entry__name">Name</p> ... </a>
      const anchors = $('a.entry__bg');

      anchors.each((_, el) => {
        const $a = $(el);
        const characterLink = $a.attr('href') || '';
        const characterName = $a.find('p.entry__name').first().text().trim();

        if (!characterLink || !characterName) return; // skip incomplete

        const idMatch = characterLink.match(/\/lodestone\/character\/(\d+)\//);
        if (!idMatch) return;

        const characterId = idMatch[1];
        if (!members[characterId]) {
          members[characterId] = {
            id: characterId,
            name: characterName,
            cached_at: Date.now()
          };
          pageCount++;
        }
      });

      // Fallback: legacy selector if new one yielded nothing (site layout variance)
      if (anchors.length === 0) {
        $('.entry').each((_, element) => {
          const $el = $(element);
          const name = $el.find('.entry__name a, .entry__name').first().text().trim();
          const link = $el.find('.entry__name a').attr('href') || $el.closest('a').attr('href');
          if (!name || !link) return;
          const idMatch = link.match(/\/lodestone\/character\/(\d+)\//);
          if (!idMatch) return;
          const characterId = idMatch[1];
          if (!members[characterId]) {
            members[characterId] = { id: characterId, name, cached_at: Date.now() };
            pageCount++;
          }
        });
      }

      log(`Parsed page ${pageNumber}: found ${pageCount} new members (cumulative: ${Object.keys(members).length})`, 'DEBUG');
      return pageCount;
    };

    while (page <= MAX_PAGES) {
      const pageUrl = page === 1 ? FFXIV_FC_URL : `${FFXIV_FC_URL}/?page=${page}`; // Lodestone pagination usually uses ?page=N
      log(`Requesting page ${page}: ${pageUrl}`, 'DEBUG');
      let response;
      try {
        response = await axios.get(pageUrl, {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
      } catch (reqErr) {
        log(`Page ${page} fetch error: ${reqErr.message}`, 'WARN');
        break; // stop further pagination on fetch error
      }

      const newOnPage = processPage(response.data, page);
      if (!newOnPage) {
        // No new members found; assume last page reached
        break;
      }
      totalFound += newOnPage;
      page++;

      // Be polite – slight delay to avoid hitting rate limits
      await new Promise(r => setTimeout(r, 250));
    }

    log(`Successfully fetched ${Object.keys(members).length} unique FC members across ${page - 1} page(s)`, 'INFO');

    await redis.setex(FC_CACHE_KEY, FC_CACHE_EXPIRY, JSON.stringify(members));
    log(`Cached FC members data (${Object.keys(members).length}) for ${FC_CACHE_EXPIRY} seconds`, 'DEBUG');

    return members;
  } catch (error) {
    log(`Error fetching FC members: ${error.message}`, 'ERROR');
    const cachedData = await redis.get(FC_CACHE_KEY);
    if (cachedData) {
      log('Using cached FC members data due to fetch error', 'WARN');
      return JSON.parse(cachedData);
    }
    return {};
  }
}

async function getFCMembers() {
  try {
    // Try to get from cache first
    const cachedData = await redis.get(FC_CACHE_KEY);
    if (cachedData) {
      const members = JSON.parse(cachedData);
      log(`Using cached FC members data (${Object.keys(members).length} members)`, 'DEBUG');
      return members;
    }
    
    // If no cache, fetch fresh data
    log('No cached FC members found, fetching fresh data...', 'INFO');
    return await fetchFCMembers();
  } catch (error) {
    log(`Error getting FC members: ${error.message}`, 'ERROR');
    return {};
  }
}

function extractLodestonCharacterId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  
  // Match various lodestone URL patterns
  const patterns = [
    /lodestone\/character\/(\d+)/i,
    /character\/(\d+)/i,
    /(\d{8,})/  // Fallback for just the ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

// Verify FC membership by checking character's lodestone page for Seventh Haven FC link
// Now also returns character name for both FC members and non-FC members
async function verifyFCMembershipFromCharacterPage(characterId) {
  try {
    const characterUrl = `https://eu.finalfantasyxiv.com/lodestone/character/${characterId}/`;
    log(`Fetching character page for double verification: ${characterUrl}`, 'DEBUG');
    
    const response = await axios.get(characterUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    // Extract character name from the page
    const characterName = $('.frame__chara__name').first().text().trim();
    
    // Look for the specific FC link as requested in the problem statement
    const fcLink = $('h4 a[href="/lodestone/freecompany/9279667032196922298/"]');
    const isSeventhHavenMember = fcLink.length > 0 && fcLink.text().includes('Seventh Haven');
    
    log(`Double verification result for character ${characterId}: ${isSeventhHavenMember ? 'IS' : 'NOT'} Seventh Haven FC member`, 'DEBUG');
    
    // Return both the FC membership status and character name
    return { isFCMember: isSeventhHavenMember, characterName };
  } catch (error) {
    log(`Error during double verification for character ${characterId}: ${error.message}`, 'WARN');
    // Return null to indicate verification failed, let the cache check be the fallback
    return null;
  }
}

async function handleNewMemberVerification(member) {
  try {
    log(`Processing new member verification for ${member.user.tag} (${member.id})`, 'INFO');
    
    // Create DM prompt for lodestone character link
    const dmEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('🎉 Welcome to the Server!')
      .setDescription(`Welcome ${member.user.username}! To complete your verification, please provide your FFXIV Lodestone character link.`)
      .addFields(
        { name: '📝 Instructions', value: '1. Go to [FFXIV Lodestone](https://eu.finalfantasyxiv.com/lodestone/)\n2. Search for your character\n3. Copy your character page URL\n4. Reply with your character URL' },
        { name: '⏰ Time Limit', value: 'You have 10 minutes to respond.' }
      )
      .setFooter({ text: 'This helps us verify FC membership and assign appropriate roles.' });

    let dmChannel = null;
    let verificationChannel = null;
    let isUsingDM = true;

    // Try to send DM first
    try {
      dmChannel = await member.user.createDM();
      await dmChannel.send({ embeds: [dmEmbed] });
      log(`Sent verification DM to ${member.user.tag}`, 'DEBUG');
    } catch (dmError) {
      log(`Failed to send DM to ${member.user.tag}: ${dmError.message}`, 'WARN');
      isUsingDM = false;
      
      // Fallback to welcome channel with button to trigger modal
      const welcomeChannelId = WELC_CH_ID || EVENT_CHANNEL_ID;
      if (welcomeChannelId) {
        try {
          verificationChannel = await member.guild.channels.fetch(welcomeChannelId);
          if (verificationChannel) {
            const fallbackEmbed = new EmbedBuilder()
              .setColor('#0099ff')
              .setTitle('🎉 Welcome to the Server!')
              .setDescription(`${member.user}, to complete your verification, please click the button below to provide your FFXIV Lodestone character link.`)
              .addFields(
                { name: '📝 What you need', value: 'Your FFXIV Lodestone character page URL' },
                { name: '📋 Instructions', value: '1. Click the button below\n2. Enter your Lodestone character link in the modal\n3. Submit to complete verification' }
              )
              .setFooter({ text: 'Click the button below to start verification.' });
            
            const verifyButton = new ButtonBuilder()
              .setCustomId(`verifyMember_${member.id}`)
              .setLabel('Start Verification')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('✅');
            
            const row = new ActionRowBuilder().addComponents(verifyButton);
            
            await verificationChannel.send({ 
              content: `${member.user}`, 
              embeds: [fallbackEmbed],
              components: [row],
              allowedMentions: { users: [member.id] }
            });
            log(`Sent verification button to welcome channel for ${member.user.tag}`, 'DEBUG');
          }
        } catch (channelError) {
          log(`Failed to send message to welcome channel: ${channelError.message}`, 'ERROR');
          await notifyAdminsForManualIntervention(member, 'Failed to send verification message');
          return;
        }
      }
    }

    // Set up message collector only for DM case
    // For channel-based verification, modal submission will handle the flow
    if (isUsingDM) {
      const filter = (message) => message.author.id === member.id;
      const collectorOptions = { 
        max: 1, 
        time: 10 * 60 * 1000, // 10 minutes
        errors: ['time']
      };

      const collector = dmChannel.createMessageCollector(collectorOptions);

      collector.on('collect', async (message) => {
        await processLodestoneLinkSubmission(member, message, isUsingDM);
      });

      collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
          log(`Verification timeout for ${member.user.tag}`, 'WARN');
          
          const timeoutEmbed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('⏰ Verification Timeout')
            .setDescription('Verification time has expired. Please contact server administrators for manual verification.');

          try {
            await dmChannel.send({ embeds: [timeoutEmbed] });
          } catch (error) {
            log(`Failed to send timeout message: ${error.message}`, 'ERROR');
          }

          await notifyAdminsForManualIntervention(member, 'Verification timeout');
        }
      });
    }

  } catch (error) {
    log(`Error in handleNewMemberVerification: ${error.message}`, 'ERROR');
    await notifyAdminsForManualIntervention(member, `Verification error: ${error.message}`);
  }
}

async function processLodestoneLinkSubmission(member, message, isUsingDM) {
  try {
    const lodestonUrl = message.content.trim();
    const characterId = extractLodestonCharacterId(lodestonUrl);
    
    if (!characterId) {
      const errorEmbed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('❌ Invalid Link')
        .setDescription('Please provide a valid FFXIV Lodestone character link.\n\nExample: `https://eu.finalfantasyxiv.com/lodestone/character/12345678/`');

      await message.reply({ embeds: [errorEmbed] });
      return;
    }

    log(`Processing lodestone character ID ${characterId} for ${member.user.tag}`, 'DEBUG');
    
    // Get FC members and check for match
    const fcMembers = await getFCMembers();
    let isFCMember = fcMembers.hasOwnProperty(characterId);
    let characterName = isFCMember ? fcMembers[characterId].name : null;
    
    // Double verification check: verify FC membership by checking character's lodestone page
    // This will also fetch the character name for non-FC members
    const verificationResult = await verifyFCMembershipFromCharacterPage(characterId);
    
    if (verificationResult !== null) {
      if (isFCMember && verificationResult.isFCMember === false) {
        // Character page shows they're not in Seventh Haven FC
        log(`Double verification failed for ${member.user.tag}: character ${characterId} not in Seventh Haven FC`, 'WARN');
        isFCMember = false;
        characterName = verificationResult.characterName; // Use character name from page
      } else if (isFCMember && verificationResult.isFCMember === true) {
        log(`Double verification confirmed for ${member.user.tag}: character ${characterId} is in Seventh Haven FC`, 'DEBUG');
        characterName = verificationResult.characterName || characterName; // Use page name if available
      } else if (!isFCMember) {
        // This is a non-FC member, get their character name from the page
        characterName = verificationResult.characterName;
        log(`Retrieved character name for non-FC member ${member.user.tag}: ${characterName}`, 'DEBUG');
      }
    } else if (isFCMember) {
      // Double verification failed due to error, keep cached result but log warning
      log(`Double verification error for ${member.user.tag}: using cached FC data as fallback`, 'WARN');
    }
    
    // Check for duplicate nicknames BEFORE role assignment (now applies to both FC members and friends)
    if (characterName) {
      const existingMember = member.guild.members.cache.find(m => 
        m.displayName === characterName && m.id !== member.id
      );
      
      if (existingMember) {
        log(`Nickname "${characterName}" already exists for user ${existingMember.user.tag} (${existingMember.id})`, 'WARN');
        
        // Check if this user has already submitted this character before (by checking their current nickname)
        const userHasPendingVerification = member.displayName.includes('(Pending Verification)');
        
        if (userHasPendingVerification) {
          // User is submitting again after already being told about duplicate
          log(`User ${member.user.tag} submitted duplicate character again, notifying admins for manual verification`, 'INFO');
          
          const adminNotificationEmbed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('🔧 Manual Verification Required')
            .setDescription(`User **${member.user.tag}** has submitted the same character link again despite duplicate warning.`)
            .addFields(
              { name: '📝 Character Details', value: `Character: **${characterName}**\nLodestone ID: **${characterId}**` },
              { name: '⚠️ Action Required', value: 'Please manually verify this user\'s identity and assign appropriate role.' }
            );
          
          await message.reply({ embeds: [adminNotificationEmbed] });
          await notifyAdminsForManualIntervention(member, `User re-submitted duplicate character: ${characterName} (ID: ${characterId})`);
          return;
        } else {
          // First time duplicate detected, prompt user to try again
          const duplicateNicknameEmbed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('⚠️ Duplicate Nickname Detected')
            .setDescription(`The character name **${characterName}** is already in this server.`)
            .addFields(
              { name: '🤔 Please Verify', value: 'Are you sure you are providing the correct Lodestone link? If this is your character, please contact server administrators for assistance.' },
              { name: '📝 Your Submission', value: `Character: **${characterName}**\nLodestone ID: **${characterId}**` },
              { name: '🔄 Next Steps', value: 'Please provide a different character link, or contact an administrator if this is truly your character.' }
            )
            .setFooter({ text: 'No role has been assigned yet. Please try again with a different character or contact admins.' });

          await message.reply({ embeds: [duplicateNicknameEmbed] });
          await member.setNickname(`${member.displayName} (Pending Verification)`);
          log(`Prompted ${member.user.tag} to provide different character due to duplicate: ${characterName}`, 'INFO');
          return; // Don't assign role, let user try again
        }
      }
    }
    
    // Determine role assignment
    let assignedRole;
    if (isFCMember) {
      assignedRole = FC_MEMBER_ROLE_ID;
      log(`${member.user.tag} verified as FC member: ${characterName}`, 'INFO');
    } else {
      assignedRole = NON_FC_MEMBER_ROLE_ID;
      log(`${member.user.tag} verified as FC Friend: ${characterName}`, 'INFO');
    }

    // Assign role
    try {
      await member.roles.add(assignedRole);
      
      // Remove the specified role after verification (for both FC members and FC friends)
      const roleToRemove = '1236395650933981254';
      try {
        if (member.roles.cache.has(roleToRemove)) {
          await member.roles.remove(roleToRemove);
          log(`Removed role ${roleToRemove} from ${member.user.tag} after verification`, 'DEBUG');
        }
      } catch (removeRoleError) {
        log(`Failed to remove role ${roleToRemove} from ${member.user.tag}: ${removeRoleError.message}`, 'WARN');
      }
      
      // Set display name for both FC members and FC friends (when character name is available)
      if (characterName) {
        try {
          await member.setNickname(characterName);
          log(`Set nickname for ${member.user.tag} to ${characterName}`, 'DEBUG');
        } catch (nicknameError) {
          log(`Failed to set nickname for ${member.user.tag}: ${nicknameError.message}`, 'WARN');
        }
      }
      
    } catch (roleError) {
      log(`Failed to assign role to ${member.user.tag}: ${roleError.message}`, 'ERROR');
      await notifyAdminsForManualIntervention(member, `Failed to assign role: ${roleError.message}`);
      return;
    }

    // Send success message - improved messages for both roles
    const successEmbed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('✅ Verification Complete')
      .setDescription(isFCMember ? 
        `Welcome to the server, **${characterName || 'FC Member'}**! You've been verified as an FC member.` :
        `Welcome to the server, **${characterName || 'FC Friend'}**! You've been verified and assigned the FC Friend role.`
      )
      .setFooter({ text: 'Enjoy your stay!' });

    await message.reply({ embeds: [successEmbed] });
    
    // Clean up verification message if in channel
    if (!isUsingDM) {
      setTimeout(async () => {
        try {
          await message.delete();
          const replyMessage = await message.channel.messages.fetch().then(messages => 
            messages.find(m => m.reference && m.reference.messageId === message.id)
          );
          if (replyMessage) {
            await replyMessage.delete();
          }
        } catch (error) {
          log(`Failed to clean up verification messages: ${error.message}`, 'DEBUG');
        }
      }, 5000); // Delete after 5 seconds
    }

  } catch (error) {
    log(`Error processing lodestone submission: ${error.message}`, 'ERROR');
    await notifyAdminsForManualIntervention(member, `Processing error: ${error.message}`);
  }
}

async function notifyAdminsForManualIntervention(member, reason) {
  try {
    const adminRoleIds = ADMIN_ROLE_IDS ? ADMIN_ROLE_IDS.split(',').map(id => id.trim()) : [];
    
    // Find admins to notify
    let adminsToNotify = [];
    
    if (adminRoleIds.length > 0) {
      const guild = member.guild;
      
      // Fetch all guild members to ensure we get offline admins too
      await guild.members.fetch();
      
      for (const roleId of adminRoleIds) {
        try {
          const role = await guild.roles.fetch(roleId);
          if (role) {
            // Get all members with this role, not just cached ones
            const membersWithRole = guild.members.cache
              .filter(guildMember => guildMember.roles.cache.has(roleId))
              .map(guildMember => guildMember.user);
            adminsToNotify.push(...membersWithRole);
          }
        } catch (error) {
          log(`Failed to fetch role ${roleId}: ${error.message}`, 'WARN');
        }
      }
    }
    
    // Fallback: notify authorized users
    if (adminsToNotify.length === 0) {
      const authorizedUserIds = AUTHORIZED_USERS ? AUTHORIZED_USERS.split(',').map(id => id.trim()) : [];
      for (const userId of authorizedUserIds) {
        try {
          const user = await client.users.fetch(userId);
          if (user) {
            adminsToNotify.push(user);
          }
        } catch (error) {
          log(`Failed to fetch authorized user ${userId}: ${error.message}`, 'WARN');
        }
      }
    }

    if (adminsToNotify.length === 0) {
      log('No admins found to notify for manual intervention', 'ERROR');
      return;
    }

    const adminEmbed = new EmbedBuilder()
      .setColor('#ff9900')
      .setTitle('🔧 Manual Intervention Required')
      .setDescription(`New member **${member.user.tag}** (${member.user.id}) requires manual verification.`)
      .addFields(
        { name: '👤 Member', value: `${member.user.tag}\n${member.user.id}`, inline: true },
        { name: '📅 Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: true },
        { name: '⚠️ Reason', value: reason, inline: false }
      )
      .setTimestamp()
      .setFooter({ text: 'Member Verification System' });

    // Send DM to each admin (parallelize)
    const notifications = adminsToNotify.map(async (admin) => {
      try {
        const dmChannel = await admin.createDM();
        await dmChannel.send({ embeds: [adminEmbed] });
        log(`Notified admin ${admin.tag} about manual intervention needed`, 'DEBUG');
      } catch (error) {
        log(`Failed to notify admin ${admin.tag}: ${error.message}`, 'WARN');
      }
    });

    await Promise.allSettled(notifications);
    
  } catch (error) {
    log(`Error in notifyAdminsForManualIntervention: ${error.message}`, 'ERROR');
  }
}





const EVENT_TYPES = [
  { name: 'Maps', value: 'maps' },
  { name: 'Extreme Trials', value: 'extreme_trials' },
  { name: 'Savage Raids', value: 'savage_raids' },
  { name: 'Ultimate Raids', value: 'ultimate_raids'},
  { name: 'Variant Dungeons', value: 'variant_dungeons' },
  { name: 'Mount Farm', value: 'mount_farm' },
  { name: 'Occult Crescent', value: 'occult_crescent' },
  { name: 'Blue Mage Skill Farm', value: 'blue_mage_skill_farm' },
  { name: 'Minion Farm', value: 'minion_farm' },
  { name: 'Treasure Trove Farm', value: 'treasure_trove_farm' },
  { name: 'Deep Dungeon', value: 'deep_dungeon' },
  { name: 'Other', value: 'other' }

];


const eventCommand = new SlashCommandBuilder()
  .setName('create-event')
  .setDescription('Create a new FF14 event')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of event')
      .setRequired(true)
      .addChoices(...EVENT_TYPES)
  )
  .addStringOption(option =>
    option.setName('date')
      .setDescription('Date (YYYY-MM-DD)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(option =>
    option.setName('time')
      .setDescription('Time (HH:MM)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(option =>
    option.setName('timezone')
      .setDescription('Timezone')
      .setRequired(true)
      .addChoices(
        { name: 'UTC (Coordinated Universal Time)', value: 'UTC' },
        { name: 'BST (British Summer Time)', value: 'BST' },
        { name: 'CET (Central European Time)', value: 'CET' }
      )
  )
  .addStringOption(option =>
    option.setName('group_type')
      .setDescription('Group composition type')
      .setRequired(true)
      .addChoices(
        { name: 'Standard (2 tanks, 2 healers, 4 DPS)', value: 'standard' },
        { name: 'Non-standard (any roles, 8 players max)', value: 'non_standard' },
        { name: 'Light party (4 players max)', value: 'light_party' }
      )
  )
  .addStringOption(option =>
    option.setName('description')
      .setDescription('Additional event description (optional)')
      .setRequired(true)
  );

// Helper function to check if a date is in DST for UK (BST)
function isUKDST(date) {
  const year = date.getFullYear();
  // DST starts last Sunday in March, ends last Sunday in October
  const marchLastSunday = new Date(year, 2, 31);
  marchLastSunday.setDate(31 - marchLastSunday.getDay());
  const octoberLastSunday = new Date(year, 9, 31);
  octoberLastSunday.setDate(31 - octoberLastSunday.getDay());
  
  return date >= marchLastSunday && date < octoberLastSunday;
}

// Helper function to check if a date is in DST for Central Europe (CEST)
function isEuropeDST(date) {
  const year = date.getFullYear();
  // DST starts last Sunday in March, ends last Sunday in October
  const marchLastSunday = new Date(year, 2, 31);
  marchLastSunday.setDate(31 - marchLastSunday.getDay());
  const octoberLastSunday = new Date(year, 9, 31);
  octoberLastSunday.setDate(31 - octoberLastSunday.getDay());
  
  return date >= marchLastSunday && date < octoberLastSunday;
}

// check for valid time and date with timezone support
function validateDateTime(dateString, timeString, timezone) {
  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) {
    return { valid: false, error: 'Invalid date format. Use: YYYY-MM-DD' };
  }

  // Validate time format  
  const timeRegex = /^\d{2}:\d{2}$/;
  if (!timeRegex.test(timeString)) {
    return { valid: false, error: 'Invalid time format. Use: HH:MM' };
  }

  // Parse date and time
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute] = timeString.split(':').map(Number);
  
  // Create date object in the specified timezone
  let eventDate;
  
  switch (timezone) {
    case 'UTC':
      eventDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
      break;
    case 'BST':
      // Create a date object in local time first
      const bstDate = new Date(year, month - 1, day, hour, minute);
      // Check if this date would be in DST
      const offsetHours = isUKDST(bstDate) ? 1 : 0; // BST is UTC+1, GMT is UTC+0
      eventDate = new Date(Date.UTC(year, month - 1, day, hour - (1 + offsetHours), minute));
      break;
    case 'CET':
      // Create a date object in local time first  
      const cetDate = new Date(year, month - 1, day, hour, minute);
      // Check if this date would be in DST
      const cetOffsetHours = isEuropeDST(cetDate) ? 2 : 1; // CEST is UTC+2, CET is UTC+1
      eventDate = new Date(Date.UTC(year, month - 1, day, hour - cetOffsetHours, minute));
      break;
    default:
      return { valid: false, error: 'Invalid timezone.' };
  }

  const now = new Date();

  if (isNaN(eventDate.getTime())) {
    return { valid: false, error: 'Invalid date or time.' };
  }

  if (eventDate <= now) {
    return { valid: false, error: 'Event date must be in the future.' };
  }

  return { valid: true, date: eventDate };
}


// Utility: role limits & emojis
const EMOJIS = {
  blu: { id: '1411591723443814510', name: 'Blu', raw: '<:Blu:1411591723443814510>' },
  occult: { id: '1411593082541047919', name: 'Occult', raw: '<:Occult:1411593082541047919>' },
  raid: { id: '1411591738782515351', name: 'Raid', raw: '<:Raid:1411591738782515351>' },
  mount: { id: '1411593193341845575', name: 'Mount', raw: '<:Mount:1411593193341845575>' },
  moogle: { id: '1411593150060957757', name: 'Moogle', raw: '<:Moogle:1411593150060957757>' },
  trial: { id: '1411591900686979144', name: 'Trial', raw: '<:Trial:1411591900686979144>' },
  group: { id: '1411589775135215718', name: 'Player32_Icon', raw: '<:Player32_Icon:1411589775135215718>' },
  maps: { id: '1411591835926790145', name: 'Maps', raw: '<:Maps:1411591835926790145>' },
  deep: { id: '1411594249853472818', name: 'Deep', raw: '<:Deep:1411594249853472818>' },
  minion: { id: '1411594326672412763', name: 'Minion', raw: '<:Minion:1411594326672412763>' },
  other: { id: '1411601184518570057', name: 'Other', raw: '<:Other:1411601184518570057>' },
  leader: { id: '1411602508723523645', name: 'Trove', raw: '<:Leader:1411602508723523645>' },
  maps_event: { raw: '<:Maps:1411591835926790145>' },
  extreme_trials_event: { raw: '<:Trial:1411591900686979144>' },
  savage_raids_event: { raw: '<:Raid:1411591738782515351>' },
  ultimate_raids_event: { raw: '<:Ultimate:1417049172380749884>' },
  variant_dungeons_event: { raw: '<:Variant:1417049257885565029>' },
  mount_farm_event: { raw: '<:Mount:1411593193341845575>' },
  occult_crescent_event: { raw: '<:Occult:1411593082541047919>' },
  blue_mage_skill_farm_event: { raw: '<:Blu:1411591723443814510>' },
  minion_farm_event: { raw: '<:Minion:1411594326672412763>' },
  treasure_trove_farm_event: { raw: '<:Moogle:1411593150060957757>' },
  deep_dungeon_event: { raw: '<:Deep:1411594249853472818>' },
  other_event: { raw: '<:Other:1411601184518570057>' },
};
const ROLE_LIMITS = { tank: 2, healer: 2, dps: 4 };
const ROLE_LIMITS_LIGHT = { tank: 1, healer: 1, dps: 2 };
const ROLE_LABELS = { tank: 'Tank', healer: 'Healer', dps: 'DPS', blue_mage: 'Blue Mage' };
const ROLE_EMOJIS = {
  tank: '<:TankRole:1409190029086953483>',    
  healer: '<:HealerRole:1409190083692728501>',
  dps: '<:DPSRole:1409190101128581191>',
  blue_mage: '<:BlueMage:1411608637130018847>'       
};
const ROLE_CLASS = {
  tank: ['Paladin', 'Warrior', 'Dark Knight', 'Gunbreaker'],
  healer: ['White Mage', 'Scholar', 'Astrologian', 'Sage'],
  dps: ['Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Bard', 'Machinist', 'Dancer', 'Black Mage', 'Summoner', 'Red Mage', 'Pictomancer', 'Viper'],
  blue_mage: [] // No subclasses
};
const ROLE_CLASS_EMOJIS = {
  warrior: '<:Warrior:1409190252471652422>',
  paladin: '<:Paladin:1409190225715925113>',
  gunbreaker: '<:Gunbreaker:1409190193608790147>',
  darkknight: '<:DarkKnight:1409190172117176470>',
  whitemage: '<:WhiteMage:1409190380469092404>',
  scholar: '<:Scholar:1409190360613392456>',
  sage: '<:Sage:1409190343525666986>',
  astrologian: '<:Astrologian:1409190327964794950>',
  viper: '<:Viper:1409190731649650839>',
  summoner: '<:Summoner:1409190713375195186>',
  samurai: '<:Samurai:1409190696467828746>',
  redmage: '<:RedMage:1409190678906278001>',
  reaper: '<:Reaper:1409190660703129632>',
  pictomancer: '<:Pictomancer:1409190639886925986>',
  ninja: '<:Ninja:1409190617057198174>',
  monk: '<:Monk:1409190594986905680>',
  machinist: '<:Machinist:1409190565861523626>',
  dragoon: '<:Dragoon:1409190544059662451>',
  dancer: '<:Dancer:1409190522513264715>',
  blackmage: '<:BlackMage:1409190482441015469>',
  bard: '<:Bard:1409190461532536945>',
};

// Update: createEventEmbed to show roles
function createEventEmbed(eventType, eventDate, organizer, description = '', participants = [], groupType = 'standard') {
  log(
    `createEventEmbed called with eventType=${eventType}, eventDate=${eventDate.toISOString()}, organizer=${organizer}, descriptionLength=${description.length}, participantsCount=${participants.length}, groupType=${groupType}`,
    'DEBUG'
  );
  const embed = new EmbedBuilder()
    .setTitle(`${EMOJIS[`${eventType}_event`]?.raw || '📅'} ${EVENT_TYPES.find(t => t.value === eventType)?.name || eventType}`)
    .setColor(0x49bbbb)
    .addFields(
      { name: '🗓️ Date & Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: true },
      { name: '⏰ Relative Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:R>`, inline: true },
      { name: `${EMOJIS.leader.raw} Organizer`, value: `<@${organizer}>`, inline: true }
    )
    .setTimestamp();

  // Add group type information
  const groupTypeLabel = groupType === 'non_standard' ? 'Non-standard (Any roles)' : groupType === 'light_party' ? 'Light Party (1T/1H/2D)' : 'Standard (2T/2H/4D)';
  embed.addFields({ name: '👥 Group Type', value: groupTypeLabel, inline: true });

  if (description) {
    embed.addFields({ name: '📝 Description', value: description });
  }

  const maxParticipants = groupType === 'light_party' ? 4 : 8;

  if (participants.length > 0) {
    // Show participants with roles and classes
    const roleGroups = { tank: [], healer: [], dps: [], blue_mage: [] };
    for (const p of participants) {
      if (roleGroups[p.role]) {
        // Add role emoji and class emoji (if available) before the mention
        let displayText = `${ROLE_EMOJIS[p.role] || ''} <@${p.id}>`;
        
        if (p.class && p.class !== 'Blue Mage') {
          const classKey = p.class.toLowerCase().replace(/\s+/g, '');
          const classEmoji = ROLE_CLASS_EMOJIS[classKey];
          if (classEmoji) {
            displayText = `${ROLE_EMOJIS[p.role] || ''} ${classEmoji} <@${p.id}>`;
          }
        }
        
        roleGroups[p.role].push(displayText);
      }
    }
    let participantList = '';
    for (const role of ['tank', 'healer', 'dps', 'blue_mage']) {
      if (roleGroups[role].length > 0) {
        let roleLimit, roleHeader;
        
        switch (groupType) {
          case 'standard':
            roleLimit = ROLE_LIMITS[role] || 0;
            roleHeader = `**${ROLE_LABELS[role]}s (${roleGroups[role].length}/${roleLimit}):**`;
            break;
          case 'light_party':
            roleLimit = ROLE_LIMITS_LIGHT[role] || 0;
            roleHeader = `**${ROLE_LABELS[role]}s (${roleGroups[role].length}/${roleLimit}):**`;
            break;
          default:
            roleHeader = `**${ROLE_LABELS[role]}s:**`;
            break;
        }
        
        participantList += `${roleHeader}\n${roleGroups[role].join('\n')}\n`;
      }
    }
    embed.addFields({ 
      name: `${EMOJIS.group.raw} Participants (${participants.length}/${maxParticipants})`, 
      value: participantList.length > 1024 ? `${participantList.substring(0, 1020)}...` : participantList 
    });
  } else {
    embed.addFields({ name: `${EMOJIS.group.raw} Participants (0/${maxParticipants})`, value: 'No participants yet' });
  }

  return embed;
}

// Add: role selection buttons
function createRoleButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`role_tank_${eventId}`)
      .setLabel('Tank')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190029086953483', name: 'TankRole' }),
    new ButtonBuilder()
      .setCustomId(`role_healer_${eventId}`)
      .setLabel('Healer')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190083692728501', name: 'HealerRole' }),
    new ButtonBuilder()
      .setCustomId(`role_dps_${eventId}`)
      .setLabel('DPS')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190101128581191', name: 'DPSRole' }),
    new ButtonBuilder()
      .setCustomId(`role_blue_mage_${eventId}`)
      .setLabel('Blue Mage')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1411608637130018847', name: 'BlueMage' })
  );
}

// New: class selection buttons for each role
function createClassButtons(role, eventId) {
  const classes = ROLE_CLASS[role];
  if (!classes || classes.length === 0) {
    return null; // No classes for this role (blue mage)
  }

  const rows = [];
  const buttonsPerRow = 5; // Discord limit
  
  for (let i = 0; i < classes.length; i += buttonsPerRow) {
    const row = new ActionRowBuilder();
    const classSlice = classes.slice(i, i + buttonsPerRow);
    
    for (const className of classSlice) {
      const emojiKey = className.toLowerCase().replace(/\s+/g, '');
      const emoji = ROLE_CLASS_EMOJIS[emojiKey];
      
      const button = new ButtonBuilder()
        .setCustomId(`class_${role}_${className.replace(/\s+/g, '_')}_${eventId}`)
        .setLabel(className)
        .setStyle(ButtonStyle.Secondary);
      
      if (emoji) {
        // Extract emoji ID and name from the custom emoji format
        const emojiMatch = emoji.match(/<:(\w+):(\d+)>/);
        if (emojiMatch) {
          button.setEmoji({ id: emojiMatch[2], name: emojiMatch[1] });
        }
      }
      
      row.addComponents(button);
    }
    rows.push(row);
  }
  
  return rows;
}

// New: role change selection buttons (separate IDs to distinguish logic)
function createRoleChangeButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rolechange_tank_${eventId}`)
      .setLabel('Tank')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190029086953483', name: 'TankRole' }),
    new ButtonBuilder()
      .setCustomId(`rolechange_healer_${eventId}`)
      .setLabel('Healer')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190083692728501', name: 'HealerRole' }),
    new ButtonBuilder()
      .setCustomId(`rolechange_dps_${eventId}`)
      .setLabel('DPS')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: '1409190101128581191', name: 'DPSRole' })
  );
}

// New: class selection buttons for role changes
function createRoleChangeClassButtons(role, eventId) {
  const classes = ROLE_CLASS[role];
  if (!classes || classes.length === 0) {
    return null; // No classes for this role (blue mage)
  }

  const rows = [];
  const buttonsPerRow = 5; // Discord limit
  
  for (let i = 0; i < classes.length; i += buttonsPerRow) {
    const row = new ActionRowBuilder();
    const classSlice = classes.slice(i, i + buttonsPerRow);
    
    for (const className of classSlice) {
      const emojiKey = className.toLowerCase().replace(/\s+/g, '');
      const emoji = ROLE_CLASS_EMOJIS[emojiKey];
      
      const button = new ButtonBuilder()
        .setCustomId(`rolechangeclass_${role}_${className.replace(/\s+/g, '_')}_${eventId}`)
        .setLabel(className)
        .setStyle(ButtonStyle.Secondary);
      
      if (emoji) {
        // Extract emoji ID and name from the custom emoji format
        const emojiMatch = emoji.match(/<:(\w+):(\d+)>/);
        if (emojiMatch) {
          button.setEmoji({ id: emojiMatch[2], name: emojiMatch[1] });
        }
      }
      
      row.addComponents(button);
    }
    rows.push(row);
  }
  
  return rows;
}

// Update: createEventButtons to show participant count
function createEventButtons(eventId, organizerId, currentUserId, participants = [], groupType = 'standard') {
  const maxParticipants = groupType === 'light_party' ? 4 : 8;
  const row1 = new ActionRowBuilder();
  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`participate_${eventId}`)
      .setLabel(`Participate (${participants.length}/${maxParticipants})`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✅')
      .setDisabled(participants.length >= maxParticipants)
  );
  // New: Withdraw button
  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`withdraw_${eventId}`)
      .setLabel('Withdraw')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('↩️')
  );
  // New: Change Role button
  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`changeRole_${eventId}`)
      .setLabel('Change Role')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄')
  );
  
  // Organizer-only buttons in a second row if needed
  if (currentUserId === organizerId) {
    // If we have space in row1, add organizer buttons there, otherwise create row2
    if (row1.components.length <= 3) {
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`changeTime_${eventId}`)
          .setLabel('Change Time')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🕒')
      );
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`delete_${eventId}`)
          .setLabel('Delete Event')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️')
      );
      return [row1];
    } else {
      const row2 = new ActionRowBuilder();
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`changeTime_${eventId}`)
          .setLabel('Change Time')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🕒')
      );
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`delete_${eventId}`)
          .setLabel('Delete Event')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️')
      );
      return [row1, row2];
    }
  }
  return [row1];
}

// Create modal for changing event time
function createChangeTimeModal(eventId) {
  const modal = new ModalBuilder()
    .setCustomId(`changeTimeModal_${eventId}`)
    .setTitle('Change Event Time');

  const dateInput = new TextInputBuilder()
    .setCustomId('new_date')
    .setLabel('New Date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('2024-12-25')
    .setMinLength(10)
    .setMaxLength(10)
    .setRequired(true);

  const timeInput = new TextInputBuilder()
    .setCustomId('new_time')
    .setLabel('New Time (HH:MM)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('20:00')
    .setMinLength(5)
    .setMaxLength(5)
    .setRequired(true);

  const timezoneInput = new TextInputBuilder()
    .setCustomId('new_timezone')
    .setLabel('Timezone (UTC, BST, or CET)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('UTC')
    .setValue('UTC')
    .setMaxLength(3)
    .setRequired(true);

  const row1 = new ActionRowBuilder().addComponents(dateInput);
  const row2 = new ActionRowBuilder().addComponents(timeInput);
  const row3 = new ActionRowBuilder().addComponents(timezoneInput);

  modal.addComponents(row1, row2, row3);
  return modal;
}

// Create modal for member verification
function createVerificationModal(memberId) {
  const modal = new ModalBuilder()
    .setCustomId(`verificationModal_${memberId}`)
    .setTitle('🎉 Welcome to the Server!');

  const lodestoneInput = new TextInputBuilder()
    .setCustomId('lodestone_url')
    .setLabel('FFXIV Lodestone Character Link')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://eu.finalfantasyxiv.com/lodestone/character/...')
    .setRequired(true);

  const row = new ActionRowBuilder().addComponents(lodestoneInput);
  modal.addComponents(row);
  return modal;
}

// Schedule reminder jobs
async function scheduleReminders(eventId, eventDate, participants) {
  const eventTimestamp = eventDate.getTime();
  const now = Date.now();  
  const reminderTimes = [
    { delay: 24 * 60 * 60 * 1000, label: '24 hours' },
    { delay: 12 * 60 * 60 * 1000, label: '12 hours' },
    { delay: 1 * 60 * 60 * 1000, label: '1 hour' }
  ];

  // Create all reminder scheduling promises
  const reminderPromises = [];
  
  for (const participant of participants) {
    for (const reminder of reminderTimes) {
      const reminderTime = eventTimestamp - reminder.delay;
      
      if (reminderTime > now) {
        const jobName = `reminder_${eventId}_${participant}_${reminder.label}`;
        const delay = reminderTime - now;

        log(
          `Scheduling reminder: jobName=${jobName}, eventId=${eventId}, participant=${participant}, reminderType=${reminder.label}, delay=${delay}ms`,
          'DEBUG'
        );

        // Add promise to array for parallel execution
        reminderPromises.push(
          reminderQueue.add(jobName, {
            eventId,
            participantId: participant,
            reminderType: reminder.label,
            eventDate: eventTimestamp
          }, {
            delay,
            removeOnComplete: true,
            removeOnFail: true
          })
        );
      } else {
        log(`Skipping past reminder for participant ${participant}: ${reminder.label}`, 'DEBUG');
      }
    }
  }

  // Execute all reminder scheduling in parallel
  if (reminderPromises.length > 0) {
    const results = await Promise.allSettled(reminderPromises);
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failedCount = results.filter(r => r.status === 'rejected').length;
    
    log(`Scheduled reminders: ${successCount} successful, ${failedCount} failed`, 'DEBUG');
    
    if (failedCount > 0) {
      const errors = results
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'Unknown error')
        .join(', ');
      log(`Reminder scheduling failures: ${errors}`, 'WARN');
    }
  }
}

// Cancel all reminders for an event
async function cancelEventReminders(eventId) {
  const jobs = await reminderQueue.getJobs(['waiting', 'delayed']);
  const eventJobs = jobs.filter(job => job.data.eventId === eventId);

  log(`Cancelling ${eventJobs.length} reminder jobs for event ${eventId}`, 'DEBUG');
  
  // Parallelize job removal
  const removalPromises = eventJobs.map(async (job) => {
    try {
      await job.remove();
      log(`Removed reminder job ${job.id} for event ${eventId}`, 'DEBUG');
    } catch (error) {
      log(`Failed to remove reminder job ${job.id}: ${error.message}`, 'WARN');
    }
  });
  
  await Promise.allSettled(removalPromises);
}

// New: cancel reminders for a single participant
async function cancelParticipantReminders(eventId, participantId) {
  const jobs = await reminderQueue.getJobs(['waiting', 'delayed']);
  const participantJobs = jobs.filter(job => job.data.eventId === eventId && job.data.participantId === participantId);
  log(`Cancelling ${participantJobs.length} reminder jobs for participant ${participantId} in event ${eventId}`, 'DEBUG');
  
  // Parallelize participant job removal
  const removalPromises = participantJobs.map(async (job) => {
    try {
      await job.remove();
      log(`Removed reminder job ${job.id} for participant ${participantId} in event ${eventId}`, 'DEBUG');
    } catch (error) {
      log(`Failed removing reminder job ${job.id}: ${error.message}`, 'DEBUG');
    }
  });
  
  await Promise.allSettled(removalPromises);
}

async function scheduleEventCleanup(eventId, eventDate) {
  const eventTimestamp = eventDate.getTime();
  const now = Date.now();
  const delay = eventTimestamp - now + (5 * 60 * 1000); // 5 minutes after event ends

  if (delay > 0) {
    await reminderQueue.add(`cleanup_${eventId}`, { eventId }, {
      delay,
      removeOnComplete: true,
      removeOnFail: true
    });
    log(`Scheduled cleanup for event ${eventId} in ${delay}ms`, 'DEBUG');
  }
}


async function handleCreateEvent(interaction) {  
  // Early return for authorization check
  if (!checkAuthorization(interaction, true)) {
      return interaction.reply(getUnauthorizedReply());
  }

  const eventType = interaction.options.getString('type');
  const groupType = interaction.options.getString('group_type') || 'standard';
  const dateString = interaction.options.getString('date');
  const timeString = interaction.options.getString('time');
  const timezone = interaction.options.getString('timezone');  
  const description = interaction.options.getString('description') || '';

  const validation = validateDateTime(dateString, timeString, timezone);
  if (!validation.valid) {
    return interaction.reply({ 
      content: `❌ ${validation.error}`, 
      ephemeral: true 
    });
  }

  const eventId = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const eventDate = validation.date;

  const event = {
    id: eventId,
    type: eventType,
    date: eventDate,
    organizer: interaction.user.id,
    description,
    groupType: groupType,
    participants: [],
    messageId: null
  };

  const embed = createEventEmbed(eventType, eventDate, interaction.user.id, description, [], groupType);
  const buttons = createEventButtons(eventId, interaction.user.id, interaction.user.id, [], groupType);

  const EVENT_CHANNEL_ID = (process.env.EVENT_CHANNEL_ID || '').trim();
  const channel = interaction.client.channels.cache.get(EVENT_CHANNEL_ID);

  if (!channel) {
    // Debug log for troubleshooting
    log('Unable to find suitable channel for event creation', 'ERROR');
    log(`Event channel ID from env: ${EVENT_CHANNEL_ID}`, 'DEBUG');
    log(`Available channel IDs: ${[...interaction.client.channels.cache.keys()].join(', ')}`, 'DEBUG');
    log(`Failed to find event channel with ID: ${EVENT_CHANNEL_ID}`, 'ERROR');
    return interaction.reply({ 
      content: `❌ Event channel not found. Bonk the dev. (ID: ${EVENT_CHANNEL_ID})`, 
      ephemeral: true 
    });
  }

  try {
    // Prepare message content with role mention if FARM_ROLE_ID is set
    let messageContent = '';
    const FARM_ROLE_ID_TRIMMED = (process.env.FARM_ROLE_ID || '').trim();
    if (FARM_ROLE_ID_TRIMMED) {
      messageContent = `<@&${FARM_ROLE_ID_TRIMMED}>`;
    }

    const message = await channel.send({ 
      content: messageContent,
      embeds: [embed], 
      components: buttons 
    });

    // Update event data with message ID
    event.messageId = message.id;
    await saveEventToRedis(event);
    await scheduleEventCleanup(eventId, eventDate);
    log(`Event ${eventId} saved to Redis with group type ${groupType}`, 'DEBUG');

    await interaction.reply({ 
      content: `✅ Event created successfully! Check ${channel}`, 
      ephemeral: true 
    });
    log(`Event ${eventId} created successfully by user ${interaction.user.id} with group type ${groupType}`, 'DEBUG');
  } catch (error) {
    log(`Error creating event: ${error.message}`, 'ERROR');
    await interaction.reply({ 
      content: '❌ Failed to create event. Bonk April.', 
      ephemeral: true 
    });
  }
}

// Helper function to parse button interactions
function parseButtonInteraction(customId) {
  const [action, ...rest] = customId.split('_');
  let eventId, role, className;
  
  switch (action) {
    case 'role':
    case 'rolechange':
      role = rest[0];
      eventId = rest.slice(1).join('_');
      break;
      
    case 'class':
    case 'rolechangeclass':
      role = rest[0];
      const eventIndex = rest.indexOf('event');
      if (eventIndex === -1) {
        throw new Error('Invalid button ID format: missing event identifier');
      }
      className = rest.slice(1, eventIndex).join('_').replace(/_/g, ' ');
      eventId = rest.slice(eventIndex).join('_');
      break;
      
    default:
      eventId = rest.join('_');
      break;
  }
  
  return { action, eventId, role, className };
}

async function handleButtonInteraction(interaction) {
  // Handle verification button separately (not event-related)
  if (interaction.customId.startsWith('verifyMember_')) {
    const memberId = interaction.customId.substring('verifyMember_'.length);
    
    // Check if the user clicking is the member who needs verification
    if (interaction.user.id !== memberId) {
      return interaction.reply({ 
        content: '❌ This verification is not for you.', 
        ephemeral: true 
      });
    }
    
    const modal = createVerificationModal(memberId);
    return await interaction.showModal(modal);
  }
  
  let parsed;
  
  try {
    parsed = parseButtonInteraction(interaction.customId);
  } catch (error) {
    return safeReply(interaction, { content: `❌ ${error.message}`, ephemeral: true });
  }
  
  const { action, eventId, role, className } = parsed;
  
  let event = await getEventFromRedis(eventId);
  if (event && event.date && !(event.date instanceof Date)) event.date = new Date(event.date);
  if (!event) {
    log(`Event not found for eventId=${eventId}`, 'DEBUG');
    return interaction.reply({ content: '❌ Event not found.', ephemeral: true });
  }
  if (!Array.isArray(event.participants)) event.participants = [];
  
  // Handle legacy participant format (convert string IDs to objects)
  if (event.participants.length > 0 && typeof event.participants[0] === 'string') {
    event.participants = event.participants.map(id => ({ id, role: 'dps', class: null }));
  }

  // Withdraw action
  if (action === 'withdraw') {
    const userId = interaction.user.id;
    const beforeLen = event.participants.length;
    event.participants = event.participants.filter(p => p.id !== userId);
    if (event.participants.length === beforeLen) {
      return interaction.reply({ content: '⚠️ You are not participating in this event.', ephemeral: true });
    }
    await saveEventToRedis(event);
    await cancelParticipantReminders(eventId, userId);
    log(`User ${userId} withdrew from event ${eventId}`, 'DEBUG');
    try {
      const channel = interaction.message?.channel || interaction.channel;
      const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants, event.groupType || 'standard');
      const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants, event.groupType || 'standard');
      if (event.messageId && channel) {
        const msg = await channel.messages.fetch(event.messageId);
        await msg.edit({ embeds: [embed], components: buttons });
      }
    } catch (e) {
      log(`Failed to update event message after withdraw for ${eventId}: ${e.message}`, 'DEBUG');
    }
    try {
      const user = await interaction.client.users.fetch(userId);
      const dmMessage = await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('↩️ You Withdrawn From Event')
          .setDescription('You have successfully withdrawn from the event.')
          .setColor(0x888888)
          .setTimestamp()]
      });
      
      // Track the DM message for later pruning
      await saveDMMessageForEvent(eventId, userId, dmMessage.id, 'withdrawal');
      
    } catch (e) {
      log(`Could not DM user ${userId} withdrawal notice: ${e.message}`, 'DEBUG');
    }
    return interaction.reply({ content: '✅ You have withdrawn from the event.', ephemeral: true });
  }

  // Change role initiation
  if (action === 'changeRole') {
    const userId = interaction.user.id;
    if (!event.participants.some(p => p.id === userId)) {
      return interaction.reply({ content: '⚠️ You are not participating. Use Participate first.', ephemeral: true });
    }
    return interaction.reply({
      content: 'Select a new role:',
      components: [createRoleChangeButtons(eventId)],
      ephemeral: true
    });
  }

  // PARTICIPATE flow unchanged
  if (action === 'participate') {
    const userId = interaction.user.id;
    if (event.participants.some(p => p.id === userId)) {
      log(`User ${userId} already participating in event ${eventId}`, 'DEBUG');
      return interaction.reply({ content: '⚠️ You are already participating in this event!', ephemeral: true });
    }
    if (event.participants.length >= 8) {
      log(`Event ${eventId} is full`, 'DEBUG');
      return interaction.reply({ content: '❌ This event is full!', ephemeral: true });
    }
    log(`Prompting user ${userId} for role selection in event ${eventId}`, 'DEBUG');
    return interaction.reply({
      content: 'Please select your role:',
      components: [createRoleButtons(eventId)],
      ephemeral: true
    });
  }

  // ROLE SELECTION (initial join) - now prompts for class selection
  if (action === 'role') {
    const userId = interaction.user.id;
    if (!['tank', 'healer', 'dps', 'blue_mage'].includes(role)) {
      log(`Invalid role "${role}" selected by user ${userId} for event ${eventId}`, 'DEBUG');
      return interaction.reply({ content: '❌ Invalid role.', ephemeral: true });
    }
    if (event.participants.some(p => p.id === userId)) {
      log(`User ${userId} already participating in event ${eventId} (role selection)`, 'DEBUG');
      return interaction.reply({ content: '⚠️ You are already participating in this event!', ephemeral: true });
    }
    if (event.participants.length >= 8) {
      log(`Event ${eventId} is full (role selection)`, 'DEBUG');
      return interaction.reply({ content: '❌ This event is full!', ephemeral: true });
    }
    const roleCount = event.participants.filter(p => p.role === role).length;
    // Only enforce role limits for standard groups
    if (event.groupType === 'standard' && roleCount >= ROLE_LIMITS[role]) {
      log(`All ${ROLE_LABELS[role]} slots filled for event ${eventId}`, 'DEBUG');
      return interaction.reply({ content: `❌ All ${ROLE_LABELS[role]} slots are filled.`, ephemeral: true });
    }

    // Check if role has classes
    if (role === 'blue_mage' || !ROLE_CLASS[role] || ROLE_CLASS[role].length === 0) {
      // Blue mage or roles without classes - join directly
      event.participants.push({ id: userId, role, class: role === 'blue_mage' ? 'Blue Mage' : null });
      await saveEventToRedis(event);
      await scheduleReminders(eventId, event.date, [userId]);
      log(`User ${userId} joined event ${eventId} as ${role}`, 'DEBUG');
      
      // Update event message
      const channel = interaction.message?.channel || interaction.channel;
      const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants, event.groupType || 'standard');
      const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants, event.groupType || 'standard');
      try {
        if (event.messageId && channel) {
          const msg = await channel.messages.fetch(event.messageId);
          await msg.edit({ embeds: [embed], components: buttons });
          log(`Event message updated for event ${eventId}`, 'DEBUG');
        }
      } catch (e) {
        log(`Failed to update event message for event ${eventId}: ${e.message}`, 'DEBUG');
      }
      
      // Send confirmation DM
      try {
        const user = await interaction.client.users.fetch(userId);
        const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
        const dmMessage = await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('✅ Event Registration Confirmed')
            .setDescription(`You have successfully registered for: **${eventTypeName}**`)
            .addFields(
              { name: '🗓️ Date & Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:F>` },
              { name: '⏰ Relative Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:R>` },
              { name: 'Role', value: ROLE_LABELS[role], inline: true }
            )
            .setColor(0x49bbbb)
            .setTimestamp()]
        });
        
        // Track the DM message for later pruning
        await saveDMMessageForEvent(eventId, userId, dmMessage.id, 'registration');
        
        log(`Confirmation DM sent to user ${userId} for event ${eventId}`, 'DEBUG');
      } catch (error) {
        log(`Could not send DM to user ${userId}: ${error.message}`, 'DEBUG');
      }
      
      return interaction.update({ content: `You have joined as **${ROLE_LABELS[role]}**!`, components: [], ephemeral: true });
    } else {
      // Role has classes - prompt for class selection
      const classButtonRows = createClassButtons(role, eventId);
      if (classButtonRows && classButtonRows.length > 0) {
        log(`Prompting user ${userId} for class selection in role ${role} for event ${eventId}`, 'DEBUG');
        return interaction.reply({
          content: `Please select your **${ROLE_LABELS[role]}** class:`,
          components: classButtonRows,
          ephemeral: true
        });
      } else {
        // Fallback - join without class
        event.participants.push({ id: userId, role, class: null });
        await saveEventToRedis(event);
        await scheduleReminders(eventId, event.date, [userId]);
        log(`User ${userId} joined event ${eventId} as ${role} (no classes available)`, 'DEBUG');
        return interaction.reply({ content: `You have joined as **${ROLE_LABELS[role]}**!`, ephemeral: true });
      }
    }
  }
  // CLASS SELECTION (after role selection)
  if (action === 'class') {
    const userId = interaction.user.id;
    
    // Validate role and class
    if (!['tank', 'healer', 'dps'].includes(role)) {
      return interaction.reply({ content: '❌ Invalid role.', ephemeral: true });
    }
    
    if (!ROLE_CLASS[role] || !ROLE_CLASS[role].includes(className)) {
      return interaction.reply({ content: '❌ Invalid class for this role.', ephemeral: true });
    }
    
    // Check if user is already participating
    if (event.participants.some(p => p.id === userId)) {
      return interaction.reply({ content: '⚠️ You are already participating in this event!', ephemeral: true });
    }
    
    // Check if event is full
    if (event.participants.length >= 8) {
      return interaction.reply({ content: '❌ This event is full!', ephemeral: true });
    }
    
    // Check role limits
    const roleCount = event.participants.filter(p => p.role === role).length;
    // Only enforce role limits for standard groups
    if (event.groupType === 'standard' && roleCount >= ROLE_LIMITS[role]) {
      return interaction.reply({ content: `❌ All ${ROLE_LABELS[role]} slots are filled.`, ephemeral: true });
    }
    
    // Add participant with role and class
    event.participants.push({ id: userId, role, class: className });
    await saveEventToRedis(event);
    await scheduleReminders(eventId, event.date, [userId]);
    log(`User ${userId} joined event ${eventId} as ${role} (${className})`, 'DEBUG');
    
    // Update event message
    const channel = interaction.message?.channel || interaction.channel;
    const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants, event.groupType || 'standard');
    const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants, event.groupType || 'standard');
    try {
      if (event.messageId && channel) {
        const msg = await channel.messages.fetch(event.messageId);
        await msg.edit({ embeds: [embed], components: buttons });
        log(`Event message updated for event ${eventId}`, 'DEBUG');
      }
    } catch (e) {
      log(`Failed to update event message for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    
    // Send confirmation DM
    try {
      const user = await interaction.client.users.fetch(userId);
      const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
      const dmMessage = await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Event Registration Confirmed')
          .setDescription(`You have successfully registered for: **${eventTypeName}**`)
          .addFields(
            { name: '🗓️ Date & Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:F>` },
            { name: '⏰ Relative Time', value: `<t:${Math.floor(event.date.getTime() / 1000)}:R>` },
            { name: 'Role', value: `${ROLE_LABELS[role]} - ${className}`, inline: true }
          )
          .setColor(0x49bbbb)
          .setTimestamp()]
      });
      
      // Track the DM message for later pruning
      await saveDMMessageForEvent(eventId, userId, dmMessage.id, 'registration');
      
      log(`Confirmation DM sent to user ${userId} for event ${eventId}`, 'DEBUG');
    } catch (error) {
      log(`Could not send DM to user ${userId}: ${error.message}`, 'DEBUG');
    }
    
    return interaction.update({ 
      content: `You have joined as **${ROLE_LABELS[role]} - ${className}**!`, 
      components: [], 
      ephemeral: true 
    });
  }

  // ROLE CHANGE selection handling - now prompts for class selection
  if (action === 'rolechange') {
    const userId = interaction.user.id;
    if (!['tank', 'healer', 'dps', 'blue_mage'].includes(role)) {
      return interaction.reply({ content: '❌ Invalid role.', ephemeral: true });
    }
    const participant = event.participants.find(p => p.id === userId);
    if (!participant) {
      return interaction.reply({ content: '⚠️ You are not participating in this event.', ephemeral: true });
    }
    if (participant.role === role) {
      if (ROLE_CLASS[role] && ROLE_CLASS[role].length > 0) {
    const classButtonRows = createRoleChangeClassButtons(role, eventId);
    return interaction.reply({
      content: `You already have this role, but you can switch class:`,
      components: classButtonRows,
      ephemeral: true
    });
  }

      return interaction.reply({ content: 'ℹ️ You already have that role.', ephemeral: true });
    }
    const roleCount = event.participants.filter(p => p.role === role && p.id !== userId).length;
    // Only enforce role limits for standard groups
    if (event.groupType === 'standard' && roleCount >= ROLE_LIMITS[role]) {
      return interaction.reply({ content: `❌ All ${ROLE_LABELS[role]} slots are filled.`, ephemeral: true });
    }

    // Check if role has classes
    if (role === 'blue_mage' || !ROLE_CLASS[role] || ROLE_CLASS[role].length === 0) {
      // Blue mage or roles without classes - change directly
      const oldRole = participant.role;
      const oldClass = participant.class;
      participant.role = role;
      participant.class = role === 'blue_mage' ? 'Blue Mage' : null;
      await saveEventToRedis(event);
      log(`User ${userId} changed role from ${oldRole} to ${role} in event ${eventId}`, 'DEBUG');
      
      // Update event message
      try {
        const channel = interaction.message?.channel || interaction.channel;
        const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants, event.groupType || 'standard');
        const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants);
        if (event.messageId && channel) {
          const msg = await channel.messages.fetch(event.messageId);
          await msg.edit({ embeds: [embed], components: buttons });
        }
      } catch (e) {
        log(`Failed to update event message after role change for event ${eventId}: ${e.message}`, 'DEBUG');
      }
      
      // DM about role switch
      try {
        const user = await interaction.client.users.fetch(userId);
        const oldDisplayRole = oldClass ? `${ROLE_LABELS[oldRole]} - ${oldClass}` : ROLE_LABELS[oldRole];
        const newDisplayRole = participant.class ? `${ROLE_LABELS[role]} - ${participant.class}` : ROLE_LABELS[role];
        const dmMessage = await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('🔄 Role Updated')
            .setDescription(`Your role for the event has been changed from **${oldDisplayRole}** to **${newDisplayRole}**.`)
            .setColor(0x49bbbb)
            .setTimestamp()]
        });
        
        // Track the DM message (role changes are preserved)
        await saveDMMessageForEvent(eventId, userId, dmMessage.id, 'role_change');
        
      } catch (e) {
        log(`Could not DM user ${userId} role change notice: ${e.message}`, 'DEBUG');
      }
      return interaction.reply({ content: `✅ Role updated: **${ROLE_LABELS[oldRole]} ➜ ${ROLE_LABELS[role]}**`, ephemeral: true });
    } else {
      // Role has classes - prompt for class selection
      const classButtonRows = createRoleChangeClassButtons(role, eventId);
      if (classButtonRows && classButtonRows.length > 0) {
        log(`Prompting user ${userId} for class selection in role change to ${role} for event ${eventId}`, 'DEBUG');
        return interaction.reply({
          content: `Please select your new **${ROLE_LABELS[role]}** class:`,
          components: classButtonRows,
          ephemeral: true
        });
      } else {
        // Fallback - change without class
        const oldRole = participant.role;
        participant.role = role;
        participant.class = null;
        await saveEventToRedis(event);
        log(`User ${userId} changed role from ${oldRole} to ${role} in event ${eventId} (no classes available)`, 'DEBUG');
        return interaction.reply({ content: `✅ Role updated: **${ROLE_LABELS[oldRole]} ➜ ${ROLE_LABELS[role]}**`, ephemeral: true });
      }
    }
  }

  // ROLE CHANGE CLASS SELECTION
  if (action === 'rolechangeclass') {
    const userId = interaction.user.id;
    
    // Validate role and class
    if (!['tank', 'healer', 'dps'].includes(role)) {
      return interaction.reply({ content: '❌ Invalid role.', ephemeral: true });
    }
    
    if (!ROLE_CLASS[role] || !ROLE_CLASS[role].includes(className)) {
      return interaction.reply({ content: '❌ Invalid class for this role.', ephemeral: true });
    }
    
    const participant = event.participants.find(p => p.id === userId);
    if (!participant) {
      return interaction.reply({ content: '⚠️ You are not participating in this event.', ephemeral: true });
    }
    
    // Check role limits (excluding current participant)
    const roleCount = event.participants.filter(p => p.role === role && p.id !== userId).length;
    // Only enforce role limits for standard groups
    if (event.groupType === 'standard' && roleCount >= ROLE_LIMITS[role]) {
      return interaction.reply({ content: `❌ All ${ROLE_LABELS[role]} slots are filled.`, ephemeral: true });
    }
    
    const oldRole = participant.role;
    const oldClass = participant.class;
    participant.role = role;
    participant.class = className;
    await saveEventToRedis(event);
    log(`User ${userId} changed role from ${oldRole} to ${role} (${className}) in event ${eventId}`, 'DEBUG');
    
    // Update event message
    try {
      const channel = interaction.message?.channel || interaction.channel;
      const embed = createEventEmbed(event.type, event.date, event.organizer, event.description, event.participants, event.groupType || 'standard');
      const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants);
      if (event.messageId && channel) {
        const msg = await channel.messages.fetch(event.messageId);
        await msg.edit({ embeds: [embed], components: buttons });
      }
    } catch (e) {
      log(`Failed to update event message after role change for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    
    // DM about role switch
    try {
      const user = await interaction.client.users.fetch(userId);
      const oldDisplayRole = oldClass ? `${ROLE_LABELS[oldRole]} - ${oldClass}` : ROLE_LABELS[oldRole];
      const newDisplayRole = `${ROLE_LABELS[role]} - ${className}`;
      const dmMessage = await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('🔄 Role Updated')
          .setDescription(`Your role for the event has been changed from **${oldDisplayRole}** to **${newDisplayRole}**.`)
          .setColor(0x49bbbb)
          .setTimestamp()]
      });
      
      // Track the DM message (role changes are preserved)
      await saveDMMessageForEvent(eventId, userId, dmMessage.id, 'role_change');
      
    } catch (e) {
      log(`Could not DM user ${userId} role change notice: ${e.message}`, 'DEBUG');
    }
    
    const oldDisplayRole = oldClass ? `${ROLE_LABELS[oldRole]} - ${oldClass}` : ROLE_LABELS[oldRole];
    const newDisplayRole = `${ROLE_LABELS[role]} - ${className}`;
    return interaction.update({ 
      content: `✅ Role updated: **${oldDisplayRole} ➜ ${newDisplayRole}**`, 
      components: [], 
      ephemeral: true 
    });
  }
  
  // Change Time action (organizer only)
  if (action === 'changeTime') {
    if (!isEventOrganizerOrAdmin(interaction.user.id, event, interaction.member)) {
      log(`User ${interaction.user.id} attempted to change time for event ${eventId} but is not organizer`, 'DEBUG');
      return interaction.reply({ content: '❌ Only the event organizer can change the event time.', ephemeral: true });
    }
    
    const modal = createChangeTimeModal(eventId);
    return await interaction.showModal(modal);
  }
  
  if (action === 'delete') {
    if (!isEventOrganizerOrAdmin(interaction.user.id, event, interaction.member)) {
      log(`User ${interaction.user.id} attempted to delete event ${eventId} but is not organizer`, 'DEBUG');
      return interaction.reply({ content: '❌ Only the event organizer can delete this event.', ephemeral: true });
    }

    // Defer early because DM loop + Redis operations may exceed 3s
    if (!interaction.deferred && !interaction.replied) {
      try { await interaction.deferReply({ ephemeral: true }); } catch (e) { /* ignore */ }
    }

    await cancelEventReminders(eventId);
    log(`Reminders cancelled for event ${eventId}`, 'DEBUG');
    const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
    
    // Parallelize participant notifications
    const notificationPromises = event.participants
      .filter(participant => participant.id !== event.organizer)
      .map(async (participant) => {
        try {
          const user = await interaction.client.users.fetch(participant.id);
          const dmMessage = await user.send({
            embeds: [new EmbedBuilder()
              .setTitle('❌ Event Cancelled')
              .setDescription(`The **${eventTypeName}** event you registered for has been cancelled by the organizer.`)
              .addFields(
                { name: 'Originally Scheduled', value: `<t:${Math.floor(event.date.getTime() / 1000)}:F>` },
                { name: 'Your Role', value: participant.class ? `${ROLE_LABELS[participant.role]} - ${participant.class}` : ROLE_LABELS[participant.role], inline: true }
              )
              .setColor(0xFF0000)
              .setTimestamp()]
          });
          await saveDMMessageForEvent(eventId, participant.id, dmMessage.id, 'cancellation');
          log(`Cancellation DM sent to user ${participant.id} for event ${eventId}`, 'DEBUG');
        } catch (error) {
          log(`Could not send cancellation DM to user ${participant.id}: ${error.message}`, 'DEBUG');
        }
      });

    await Promise.allSettled(notificationPromises);
    await deleteEventFromRedis(eventId);
    log(`Event ${eventId} deleted from Redis`, 'DEBUG');
    try {
      if (interaction.message && interaction.message.deletable) {
        await interaction.message.delete();
        log(`Event message deleted for event ${eventId}`, 'DEBUG');
      }
    } catch (e) {
      log(`Failed to delete event message for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply({ content: '✅ Event deleted successfully.' }); } catch (e) {}
    } else {
      try { await interaction.reply({ content: '✅ Event deleted successfully.', ephemeral: true }); } catch (e) {}
    }
  }
}

// BullMQ Worker for processing reminders
const reminderWorker = new Worker('event-reminders', async (job) => {
  const { eventId, participantId, reminderType, eventDate } = job.data;
  

  if (job.name.startsWith('cleanup_')) {
  const { eventId } = job.data;
  const event = await getEventFromRedis(eventId);
  if (event) {
    // Prune DMs for completed event
    try {
      await pruneDMsForCompletedEvent(eventId, event);
      log(`DM pruning completed for event ${eventId}`, 'DEBUG');
    } catch (e) {
      log(`Failed to prune DMs for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    
    // Delete the event message from Discord
    try {
      const channel = client.channels.cache.get(EVENT_CHANNEL_ID);
      if (channel && event.messageId) {
        const msg = await channel.messages.fetch(event.messageId);
        await msg.delete();
        log(`Event message deleted for event ${eventId} (auto-cleanup)`, 'DEBUG');
      }
    } catch (e) {
      log(`Failed to delete event message for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    await deleteEventFromRedis(eventId);
    log(`Event ${eventId} auto-deleted after event time`, 'DEBUG');
  }
  return;
}


  // Check if event still exists
  const event = await getEventFromRedis(eventId);
  if (!event) {
    log(`Event ${eventId} no longer exists, skipping reminder`, 'DEBUG');
    return;
  }

  // Check if user is still a participant
  if (!event.participants.some(p => p.id === participantId)) {
    log(`User ${participantId} no longer participating in ${eventId}, skipping reminder`, 'DEBUG');
    return;
}

  try {
    const user = await client.users.fetch(participantId);
    if (!user) {
      log(`Could not fetch user ${participantId} for reminder: ${error.message}`, 'WARN');
      log(`Could not fetch user ${participantId} for reminder`, 'DEBUG');
      return;
    }

    const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
    
    const embed = new EmbedBuilder()
      .setTitle(`⏰ Event Reminder - ${reminderType} remaining`)
      .setDescription(`Don't forget about the **${eventTypeName}** event!`)
      .addFields(
        { name: '🗓️ Date & Time', value: `<t:${Math.floor(eventDate / 1000)}:F>` },
        { name: '⏰ Time Remaining', value: `<t:${Math.floor(eventDate / 1000)}:R>` }
      )
      .setColor(0xFFAA00)
      .setTimestamp();

    if (event.description) {
      embed.addFields({ name: '📝 Description', value: event.description });
    }

    await user.send({ embeds: [embed] });
    log(`Sent ${reminderType} reminder to ${user.tag} for event ${eventId}`, 'DEBUG');
    log(`Sent ${reminderType} reminder to ${user.tag} for event ${eventId}`, 'DEBUG');
    
  } catch (error) {
    log(`Failed to send reminder to ${participantId}: ${error.message}`, 'ERROR');
    log(`Failed to send reminder to ${participantId}: ${error.message}`, 'DEBUG');
  }
}, { connection: redis });

// Error handling for worker
reminderWorker.on('failed', (job, err) => {
  log(`Reminder job ${job.id} failed: ${err.message}`, 'ERROR');
  log(`Reminder job ${job.id} failed: ${err.message}`, 'DEBUG');
});







const pvpLvl = [
    0, 0, 2000, 4000, 6000, 8000, 11000, 14000, 17000, 20000, 23000, 27000, 
    31000, 35000, 39000, 43000, 48500, 54000, 59500, 65000, 70500, 78000, 85500, 
    93000, 100500, 108000, 118000, 128000, 138000, 148000, 158000, 178000, 198000, 
    218000, 238000, 258000, 278000, 298000, 318000, 338000, 358000
];


const frontlineWin_Exp = 1500;
const frontlineLose2_Exp = 1250;
const frontlineLose_Exp = 1000;
const frontlineDailyWin_Exp = 3000;
const frontlineDailyLose2_Exp = 2750;
const frontlineDailyLose_Exp = 2500;
const CrystalineWin_Exp = 900;
const CrystalineLose_Exp = 700;
const rivalwingsWin_Exp = 1250;
const rivalwingsLose_Exp = 750;


const TOKEN = process.env.DISCORD_TOKEN; 
const CLIENT_ID = process.env.CLIENT_ID;


// Bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildMembers
    ],
    presence: {
        activities: [{
            name: 'Brewing☕',
            type: ActivityType.Custom
        }]
    }
});


// Data storage
let config = {
    predUserIds: process.env.AUTHORIZED_USERS,    
    
};

// Logging function
function log(message, level = 'DEBUG') {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} ${level}: ${message}`;
    
    // Use console based on log level
    switch (level) {
        case 'ERROR':
            console.error(logMessage);
            break;
        case 'WARN':
            console.warn(logMessage);
            break;
        case 'INFO':
            console.info(logMessage);
            break;
        default:
            console.log(logMessage);
            break;
    }
    
    // Async file append with error handling
    fs.appendFile('bot.log', logMessage + '\n').catch(err => {
        console.error(`Failed to write to log file: ${err.message}`);
    });
}

// Safe reply helper to avoid "Unknown interaction" errors when already acknowledged
function safeReply(interaction, payload) {
  try {
    if (!interaction) return;
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ ...payload }).catch(() => {});
    }
    return interaction.reply({ ...payload }).catch(() => {});
  } catch (_) {
    // swallow
  }
}

// Authorization utility functions
function isAuthorizedUser(userId) {
  if (!AUTHORIZED_USERS) return false;
  const authorizedIds = AUTHORIZED_USERS.split(',').map(id => id.trim()).filter(Boolean);
  return authorizedIds.includes(userId);
}

function hasAuthorizedRole(member) {
  if (!AUTHORIZED_ROLE_ID || !member?.roles?.cache) return false;
  return member.roles.cache.has(AUTHORIZED_ROLE_ID);
}

function isEventOrganizerOrAdmin(userId, event, member) {
  return userId === event.organizer || hasAuthorizedRole(member);
}

function getUnauthorizedReply() {
  return { content: '❌ You are not authorized to use this command.', ephemeral: true };
}

// Early return helper for unauthorized access
function checkAuthorization(interaction, requireRole = false) {
  const userId = interaction.user.id;
  const isUserAuthorized = isAuthorizedUser(userId);
  const hasRole = hasAuthorizedRole(interaction.member);
  
  if (requireRole) {
    return hasRole || isUserAuthorized;
  }
  
  return isUserAuthorized;
}

async function loadConfig() {
    try {
        const data = await fs.readFile('config.json', 'utf8');
        config = { ...config, ...JSON.parse(data) };
        log('Configuration loaded');
    } catch (error) {
        log('No existing config found, using defaults', 'WARN');
    }
}

async function saveConfig() {
    try {
        await fs.writeFile('config.json', JSON.stringify(config, null, 2));
        log('Configuration saved');
    } catch (error) {
        log(`Error saving config: ${error.message}`, 'ERROR');
    }
}

// We talking
async function sendMessages(message, imagePaths = []) {
    for (const userId of config.predUserIds) {
        try {
            const user = await client.users.fetch(userId);                      
                        
            await user.send({ content: message });
            log(`Message sent to ${userId}: ${message}`);
        } catch (error) {
            log(`Error sending message to ${userId}: ${error.message}`, 'ERROR');
        }
    }
}


// Here be PvP
function calculatePvPXP(currentLevel, goalLevel, currentProgress) {
    // Validation
    if (currentLevel < 1 || currentLevel > 40) {
        throw new Error('Current level must be between 1 and 40');
    }
    if (goalLevel < 1 || goalLevel > 40) {
        throw new Error('Goal level must be between 1 and 40');
    }
    if (currentLevel >= goalLevel) {
        throw new Error('Goal level must be higher than current level');
    }
    
    const current_level_memory = pvpLvl[currentLevel];
    const goal_level_memory = pvpLvl[goalLevel];
    const maxProgress = goal_level_memory - current_level_memory;
    
    if (currentProgress < 0 || currentProgress >= maxProgress) {
        throw new Error(`Current progress must be between 0 and ${maxProgress - 1}`);
    }
    
    const exp = goal_level_memory - current_level_memory - currentProgress;

    // match calculation
    const results = {
        expNeeded: exp,
        crystallineConflict: {
            wins: Math.ceil(exp / CrystalineWin_Exp),
            losses: Math.ceil(exp / CrystalineLose_Exp)
        },
        frontline: {
            wins: Math.ceil(exp / frontlineWin_Exp),
            secondPlace: Math.ceil(exp / frontlineLose2_Exp),
            losses: Math.ceil(exp / frontlineLose_Exp)
        },
        frontlineDaily: {
            wins: Math.ceil(exp / frontlineDailyWin_Exp),
            secondPlace: Math.ceil(exp / frontlineDailyLose2_Exp),
            losses: Math.ceil(exp / frontlineDailyLose_Exp)
        },
        rivalWings: {
            wins: Math.ceil(exp / rivalwingsWin_Exp),
            losses: Math.ceil(exp / rivalwingsLose_Exp)
        }
    };

    return results;
}


async function handlePvPCalculator(interaction) {
    const currentLevel = interaction.options.getInteger('current_level');
    const goalLevel = interaction.options.getInteger('goal_level');
    const currentProgress = interaction.options.getInteger('current_progress') || 0;

    try {        
        await interaction.reply({
            content: '⚔️ Calculating your PvP Malmstone requirements... ⚔️',
            ephemeral: true
        });

        // Add small delay for effect
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const results = calculatePvPXP(currentLevel, goalLevel, currentProgress);

        
        let responseMessage = `⚔️ **PvP Malmstone Calculator** ⚔️\n`;
        responseMessage += `📊 **From Level ${currentLevel} to Level ${goalLevel}**\n`;
        if (currentProgress > 0) {
            responseMessage += `📈 **Current Progress:** ${currentProgress.toLocaleString()} XP\n`;
        }
        responseMessage += `🎯 **XP Needed:** ${results.expNeeded.toLocaleString()}\n\n`;

        responseMessage += `**📋 Matches Required:**\n`;
        responseMessage += `\`\`\`\n`;
        responseMessage += `🔸 CRYSTALLINE CONFLICT\n`;
        responseMessage += `   Wins:   ${results.crystallineConflict.wins.toLocaleString()} matches\n`;
        responseMessage += `   Losses: ${results.crystallineConflict.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 FRONTLINE\n`;
        responseMessage += `   1st Place: ${results.frontline.wins.toLocaleString()} matches\n`;
        responseMessage += `   2nd Place: ${results.frontline.secondPlace.toLocaleString()} matches\n`;
        responseMessage += `   3rd Place: ${results.frontline.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 FRONTLINE (Roulette with Daily Bonus)\n`;
        responseMessage += `   1st Place: ${results.frontlineDaily.wins.toLocaleString()} matches\n`;
        responseMessage += `   2nd Place: ${results.frontlineDaily.secondPlace.toLocaleString()} matches\n`;
        responseMessage += `   3rd Place: ${results.frontlineDaily.losses.toLocaleString()} matches\n\n`;
        
        responseMessage += `🔸 RIVAL WINGS\n`;
        responseMessage += `   Wins:   ${results.rivalWings.wins.toLocaleString()} matches\n`;
        responseMessage += `   Losses: ${results.rivalWings.losses.toLocaleString()} matches\n`;
        responseMessage += `\`\`\`\n`;        

        await interaction.editReply({
            content: responseMessage,            
        });

        log(`PvP Calculator: Level ${currentLevel} → ${goalLevel}, Progress: ${currentProgress}, XP needed: ${results.expNeeded}`);

    } catch (error) {
        log(`Error in PvP calculator: ${error.message}`, 'ERROR');
        
        let errorMessage = '❌ **Error calculating PvP requirements!**\n';
        if (error.message.includes('Goal level must be higher')) {
            errorMessage += '🎯 Goal level must be higher than current level';
        } else if (error.message.includes('Current progress must be between')) {
            errorMessage += `📈 ${error.message}`;
        } else if (error.message.includes('level must be between')) {
            errorMessage += '📊 PvP levels must be between 1 and 40';
        } else {
            errorMessage += '🔧 Please check your input values and try again';
        }

        await interaction.editReply({
            content: errorMessage
        });
    }
}


// Dice roll function with animation
async function rollDice(interaction, sides = 6, count = 1) {
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const animationFrames = ['🎲', '🎯', '⭐', '✨', '💫', '🌟'];
    
    try {        
        await interaction.reply({
            content: `🎲 Rolling ${count} ${sides}-sided dice... ${animationFrames[0]}`,
            ephemeral: true
        });
        
        for (let frame = 1; frame < animationFrames.length; frame++) {
            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay
            await interaction.editReply({
                content: `🎲 Rolling ${count} ${sides}-sided dice... ${animationFrames[frame]}`
            });
        }

        // any lower than 300 and bot will behave funky or message will be jumbled somehow
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const results = [];
        let total = 0;
        
        for (let i = 0; i < count; i++) {
            const roll = Math.floor(Math.random() * sides) + 1;
            results.push(roll);
            total += roll;
        }
        
        let resultMessage = `🎲 **Dice Roll Results!** 🎲\n`;
        
        if (count === 1) {
            // Single die - show emoji if it's a standard 6-sided die
            if (sides === 6) {
                resultMessage += `${diceEmojis[results[0] - 1]} **You rolled: ${results[0]}**`;
            } else {
                resultMessage += `🎯 **You rolled: ${results[0]}** (d${sides})`;
            }
        } else {
            // Multiple dice
            resultMessage += `🎯 **Individual rolls:** ${results.join(', ')}\n`;
            resultMessage += `✨ **Total:** ${total}`;
            
            if (count > 1) {
                const average = (total / count).toFixed(1);
                resultMessage += `\n📊 **Average:** ${average}`;
            }
        }

        // vanity results, add more for fun
        if (sides === 6) {
            if (results.includes(6)) {
                resultMessage += `\n🌟 *Nice! You got a 6!*`;
            }
            if (results.includes(1)) {
                resultMessage += `\n😅 *Ouch, a 1...*`;
            }
            if (count > 1 && results.every(r => r === 6)) {
                resultMessage += `\n🎉 **AMAZING! ALL SIXES!** 🎉`;
            }
            if (count > 1 && results.every(r => r === 1)) {
                resultMessage += `\n💀 *Yikes... all ones. Better luck next time!*`;
            }
        }     

        
        await interaction.editReply({
            content: resultMessage,
            
        });

        log(`Dice roll: ${count}d${sides} = ${results.join(', ')} (total: ${total})`);

    } catch (error) {
        log(`Error in dice roll: ${error.message}`, 'ERROR');
        await interaction.editReply({
            content: '❌ Sorry, something went wrong with the dice roll!'
        });
    }
}


//debug function to show the list of active events in redis
async function listActiveEvents(interaction) {
    const eventIds = await redis.hkeys('events');
    if (eventIds.length === 0) {
        return interaction.reply({ content: 'No active events found.', ephemeral: true });
    }
    let message = '**Active Events:**\n';
    for (const eventId of eventIds) {
        const event = await getEventFromRedis(eventId);
        message += `• **ID:** ${event.id}\n  **Type:** ${event.type}\n  **Date:** <t:${Math.floor(new Date(event.date).getTime() / 1000)}:F>\n  **Organizer:** <@${event.organizer}>\n  **Participants:** ${event.participants.length}\n\n`;
    }
    return interaction.reply({ content: message, ephemeral: true });
}

//function to purge all events from redis (for testing)
async function purgeAllEvents() {
    const eventIds = await redis.hkeys('events');
    for (const eventId of eventIds) {
        await deleteEventFromRedis(eventId);
        await cancelEventReminders(eventId);
    }
    log('All events purged from debug command', 'INFO');
} 

// Slash commands
const commands = [    
    new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll a dice with animation!')
        .addIntegerOption(option =>
            option.setName('sides')
                .setDescription('Number of sides on the dice (default: 6)')
                .setMinValue(2)
                .setMaxValue(100)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('Number of dice to roll (default: 1)')
                .setMinValue(1)
                .setMaxValue(10)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('pvp')
        .setDescription('Calculate PvP Malmstone requirements')
        .addIntegerOption(option =>
            option.setName('current_level')
                .setDescription('Your current PvP level (1-40)')
                .setMinValue(1)
                .setMaxValue(40)
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('goal_level')
                .setDescription('Your target PvP level (1-40)')
                .setMinValue(1)
                .setMaxValue(40)
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('current_progress')
                .setDescription('Your current XP progress in current level (default: 0)')
                .setMinValue(0)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('create-event')
  .setDescription('Create a new FF14 event')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of event')
      .setRequired(true)
      .addChoices(...EVENT_TYPES)
  )
  .addStringOption(option =>
    option.setName('date')
      .setDescription('Date (YYYY-MM-DD)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(option =>
    option.setName('time')
      .setDescription('Time (HH:MM)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(option =>
    option.setName('timezone')
      .setDescription('Timezone')
      .setRequired(true)
      .addChoices(
        { name: 'UTC (Coordinated Universal Time)', value: 'UTC' },
        { name: 'BST (British Summer Time)', value: 'BST' },
        { name: 'CET (Central European Time)', value: 'CET' }
      )
  )
  .addStringOption(option =>
    option.setName('group_type')
      .setDescription('Group composition type')
      .setRequired(true)
      .addChoices(
        { name: 'Standard (2 tanks, 2 healers, 4 DPS)', value: 'standard' },
        { name: 'Non-standard (any roles, 8 players max)', value: 'non_standard' },
        { name: 'Light party (4 players max)', value: 'light_party' }
      )
  )
  .addStringOption(option =>
    option.setName('description')
      .setDescription('Additional event description (optional)')
      .setRequired(true)
  ),
    new SlashCommandBuilder()
        .setName('list-events')
        .setDescription('List all active events (debug)'),        
    new SlashCommandBuilder()
        .setName('purge-events')
        .setDescription('Purge all events (debug)'),
    // Trivia commands
    new SlashCommandBuilder()
        .setName('trivia')
        .setDescription('Start a trivia quiz event'),
    new SlashCommandBuilder()
        .setName('purge-quiz')
        .setDescription('Remove all messages from a specific quiz session')
        .addStringOption(option =>
            option.setName('session')
                .setDescription('Session ID to purge (format: timestamp-channelId)')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('list-sessions')
        .setDescription('List all active quiz sessions in this server'),
];

// OK so this section about upload and config loading is old and deprecated. it was from another function from a personal project
// but I left it in because I might want to add more functionality later
// and it might be useful for reference.
// It does not affect current bot functionality. 
client.once('ready', async () => {
    log(`Logged in as ${client.user.tag}`);
    
    // Create uploads directory if it doesn't exist
    try {
        await fs.mkdir('uploads', { recursive: true });
    } catch (error) {
        // Directory already exists
    }
    
    // Load configuration
    await loadConfig();
    
    // Initialize FC member cache
    try {
        log('Initializing FC member cache...', 'INFO');
        await fetchFCMembers();
        
        // Set up periodic cache refresh (every 24 hours)
        setInterval(async () => {
            try {
                log('Refreshing FC member cache...', 'INFO');
                await fetchFCMembers();
            } catch (error) {
                log(`Error during periodic FC cache refresh: ${error.message}`, 'ERROR');
            }
        }, FC_CACHE_EXPIRY * 1000);
        
    } catch (error) {
        log(`Error initializing FC member cache: ${error.message}`, 'ERROR');
    }
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        log('Slash commands registered successfully');
    } catch (error) {
        log(`Error registering slash commands: ${error.message}`, 'ERROR');
    }  
    
    
    log('Bot started successfully');
});

// Handle modal submissions
async function handleModalSubmission(interaction) {
  const customId = interaction.customId;
  
  // Handle verification modal submission
  if (customId.startsWith('verificationModal_')) {
    const memberId = customId.substring('verificationModal_'.length);
    
    // Verify the user submitting is the member
    if (interaction.user.id !== memberId) {
      return interaction.reply({ 
        content: '❌ This verification is not for you.', 
        ephemeral: true 
      });
    }
    
    const lodestoneUrl = interaction.fields.getTextInputValue('lodestone_url');
    
    // Create a mock message object to work with existing processLodestoneLinkSubmission
    const mockMessage = {
      content: lodestoneUrl,
      author: interaction.user,
      channel: interaction.channel,
      id: interaction.id, // Use interaction ID as message ID
      reply: async (payload) => {
        // For modal submissions, we reply to the interaction instead
        if (!interaction.replied && !interaction.deferred) {
          return await interaction.reply({ ...payload, ephemeral: false });
        } else {
          return await interaction.followUp({ ...payload, ephemeral: false });
        }
      },
      delete: async () => {
        // Mock delete - for modal submissions, we don't need to delete anything
        // The interaction response will be handled by Discord
        log(`Mock message delete called for modal verification`, 'DEBUG');
      }
    };
    
    // Get the member object
    const member = interaction.guild.members.cache.get(memberId) || await interaction.guild.members.fetch(memberId);
    
    // Process the verification using the existing function
    // Pass isUsingDM = false to indicate this is a channel-based interaction
    await processLodestoneLinkSubmission(member, mockMessage, false);
    return;
  }
  
  if (customId.startsWith('changeTimeModal_')) {
    const eventId = customId.substring('changeTimeModal_'.length);
    const event = await getEventFromRedis(eventId);
    if (!event) {
      return interaction.reply({ content: '❌ Event not found.', ephemeral: true });
    }
    
    // Verify user is organizer
    if (!isEventOrganizerOrAdmin(interaction.user.id, event, interaction.member)) {
      return interaction.reply({ content: '❌ Only the event organizer can change the event time.', ephemeral: true });
    }
    
    const newDate = interaction.fields.getTextInputValue('new_date');
    const newTime = interaction.fields.getTextInputValue('new_time');
    const newTimezone = interaction.fields.getTextInputValue('new_timezone');
    
    // Validate the new date/time
    const validation = validateDateTime(newDate, newTime, newTimezone);
    if (!validation.valid) {
      return interaction.reply({
        content: `❌ ${validation.error}`,
        ephemeral: true
      });
    }
    
    const oldDate = new Date(event.date);
    const newEventDate = validation.date;
    
    // Update event with new time
    event.date = newEventDate;
    await saveEventToRedis(event);
    
    // Cancel old reminders and schedule new ones
    await cancelEventReminders(eventId);
    await scheduleReminders(eventId, newEventDate, event.participants.map(p => p.id));
    
    log(`Event ${eventId} time changed from ${oldDate.toISOString()} to ${newEventDate.toISOString()}`, 'DEBUG');
    
    // Update the event message
    try {
      let channel = interaction.message?.channel || interaction.channel;
      if (!channel && interaction.channelId) {
        channel = await interaction.client.channels.fetch(interaction.channelId);
      }
      
      // If we still can't get the channel, try to get it from the EVENT_CHANNEL_ID
      if (!channel) {
        const EVENT_CHANNEL_ID = (process.env.EVENT_CHANNEL_ID || '').trim();
        if (EVENT_CHANNEL_ID) {
          channel = await interaction.client.channels.fetch(EVENT_CHANNEL_ID);
        }
      }
      
      const embed = createEventEmbed(event.type, newEventDate, event.organizer, event.description, event.participants, event.groupType || 'standard');
      const buttons = createEventButtons(eventId, event.organizer, event.organizer, event.participants, event.groupType || 'standard');
      
      if (event.messageId && channel) {
        const msg = await channel.messages.fetch(event.messageId);
        await msg.edit({ embeds: [embed], components: buttons });
        log(`Event message updated with new time for event ${eventId}`, 'DEBUG');
      }
    } catch (e) {
      log(`Failed to update event message after time change for event ${eventId}: ${e.message}`, 'DEBUG');
    }
    
    // Send time change DMs to all participants (parallelize)
    const eventTypeName = EVENT_TYPES.find(t => t.value === event.type)?.name || event.type;
    
    const timeChangePromises = event.participants
      .filter(participant => participant.id !== event.organizer)
      .map(async (participant) => {
        try {
          const user = await interaction.client.users.fetch(participant.id);
          const dmMessage = await user.send({
            embeds: [new EmbedBuilder()
              .setTitle('🕒 Event Time Changed')
              .setDescription(`The time for **${eventTypeName}** has been changed by the organizer.`)
              .addFields(
                { name: '🗓️ Old Time', value: `<t:${Math.floor(oldDate.getTime() / 1000)}:F>`, inline: true },
                { name: '🗓️ New Time', value: `<t:${Math.floor(newEventDate.getTime() / 1000)}:F>`, inline: true },
                { name: '⏰ Relative Time', value: `<t:${Math.floor(newEventDate.getTime() / 1000)}:R>`, inline: true }
              )
              .setColor(0x49bbbb)
              .setTimestamp()]
          });
          
          // Track the DM message for later pruning
          await saveDMMessageForEvent(eventId, participant.id, dmMessage.id, 'time_change');
          
          log(`Time change DM sent to user ${participant.id} for event ${eventId}`, 'DEBUG');
        } catch (error) {
          log(`Could not send time change DM to user ${participant.id}: ${error.message}`, 'DEBUG');
        }
      });

    await Promise.allSettled(timeChangePromises);
    
    await interaction.reply({
      content: `✅ Event time successfully changed from <t:${Math.floor(oldDate.getTime() / 1000)}:F> to <t:${Math.floor(newEventDate.getTime() / 1000)}:F>. All participants have been notified.`,
      ephemeral: true
    });
  }
}

// Handle autocomplete interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    
    const { commandName, options } = interaction;
    
    if (commandName === 'create-event') {
        const focusedOption = options.getFocused(true);
        let choices = [];
        
        if (focusedOption.name === 'date') {
            // Generate date suggestions
            const today = new Date();
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);
            const dayAfter = new Date(today);
            dayAfter.setDate(today.getDate() + 2);
            const dayAfterTomorrow = new Date(today);
            dayAfterTomorrow.setDate(today.getDate() + 3);
            const dayAfterDayAfter = new Date(today);
            dayAfterDayAfter.setDate(today.getDate() + 4);
            const dayAfterDayAfter2 = new Date(today);
            dayAfterDayAfter2.setDate(today.getDate() + 5);
            const dayAfterDayAfter3 = new Date(today);
            dayAfterDayAfter3.setDate(today.getDate() + 6);
            const nextWeek = new Date(today);
            nextWeek.setDate(today.getDate() + 7);
            
            const formatDate = (date) => date.toISOString().split('T')[0];
            
            choices = [
                { name: `Today (${formatDate(today)})`, value: formatDate(today) },
                { name: `Tomorrow (${formatDate(tomorrow)})`, value: formatDate(tomorrow) },
                { name: `Day After (${formatDate(dayAfter)})`, value: formatDate(dayAfter) },
                { name: `In 3 Days (${formatDate(dayAfterTomorrow)})`, value: formatDate(dayAfterTomorrow) },
                { name: `In 4 Days (${formatDate(dayAfterDayAfter)})`, value: formatDate(dayAfterDayAfter) },
                { name: `In 5 Days (${formatDate(dayAfterDayAfter2)})`, value: formatDate(dayAfterDayAfter2) },
                { name: `In 6 Days (${formatDate(dayAfterDayAfter3)})`, value: formatDate(dayAfterDayAfter3) },
                { name: `Next Week (${formatDate(nextWeek)})`, value: formatDate(nextWeek) }                
            ];
            
            // If user is typing, filter suggestions
            if (focusedOption.value) {
                choices = choices.filter(choice => 
                    choice.name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
                    choice.value.includes(focusedOption.value)
                );
            }
        }
        
        if (focusedOption.name === 'time') {
            // Generate common time suggestions
            const commonTimes = [
                '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', 
                '19:00', '20:00', '21:00', '22:00', '23:00'
            ];
            
            choices = commonTimes.map(time => ({ name: time, value: time }));
            
            // If user is typing, filter suggestions
            if (focusedOption.value) {
                choices = choices.filter(choice => 
                    choice.value.includes(focusedOption.value)
                );
            }
        }
        
        await interaction.respond(choices.slice(0, 25)); // Discord limits to 25 choices
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        
        try {
            // Check if it's a trivia command
            if (commandName === 'trivia' || commandName === 'purge-quiz' || commandName === 'list-sessions') {
                await triviaModule.handleTriviaInteraction(client, log, interaction);
                return;
            }

            switch (commandName) {            
                case 'roll':
                    const sides = interaction.options.getInteger('sides') || 6;
                    const count = interaction.options.getInteger('count') || 1;
                    log(`Dice roll command: ${count}d${sides}`);                
                    await rollDice(interaction, sides, count);
                    break;
                case 'pvp':
                    const clvl = interaction.options.getInteger('current_level');
                    const glvl = interaction.options.getInteger('goal_level');
                    const cprog = interaction.options.getInteger('current_progress');
                    log('Getting variables from interaction');
                    await handlePvPCalculator(interaction, clvl, glvl, cprog);
                    break;
                case 'create-event':
                    await handleCreateEvent(interaction);
                    break;
                case 'list-events':
                case 'purge-events':
                    if (!checkAuthorization(interaction)) {
                        return interaction.reply(getUnauthorizedReply());
                    }
                    
                    if (commandName === 'list-events') {
                        await listActiveEvents(interaction);
                    } else {
                        await purgeAllEvents();
                        await interaction.reply({ content: '✅ All events purged (debug).', ephemeral: true });
                    }
                    break;    
            }
        } catch (error) {
            log(`Error executing command ${commandName}: ${error.message}`, 'ERROR');
            await interaction.reply('An error occurred while executing the command.');
        }
    }
});

// Separate handler for button interactions
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        try {
            // Check if it's a trivia button (starts with "answer_")
            if (interaction.customId.startsWith("answer_")) {
                await triviaModule.handleTriviaInteraction(client, log, interaction);
                return;
            }
            
            await handleButtonInteraction(interaction);
        } catch (error) {
            log(`Error handling button interaction: ${error.message}`, 'ERROR');
            await safeReply(interaction, { content: 'An error occurred while handling the button interaction.', ephemeral: true });
        }
    }
    
    // Handle select menu interactions (for trivia)
    if (interaction.isStringSelectMenu()) {
        try {
            // Check if it's a trivia select menu
            if (interaction.customId === "trivia_category" || interaction.customId.startsWith("trivia_time_")) {
                await triviaModule.handleTriviaInteraction(client, log, interaction);
                return;
            }
        } catch (error) {
            log(`Error handling select menu interaction: ${error.message}`, 'ERROR');
            await safeReply(interaction, { content: 'An error occurred while handling the selection.', ephemeral: true });
        }
    }
});

// Handle modal submissions
client.on('interactionCreate', async interaction => {
    if (interaction.isModalSubmit()) {
        try {
            await handleModalSubmission(interaction);
        } catch (error) {
            log(`Error handling modal submission: ${error.message}`, 'ERROR');
            await interaction.reply({ content: 'An error occurred while handling the modal submission.', ephemeral: true });
        }
    }
});

// Handle guild member join events
client.on('guildMemberAdd', async (member) => {
    try {
        log(`New member joined: ${member.user.tag} (${member.id})`, 'INFO');
        await handleNewMemberVerification(member);
    } catch (error) {
        log(`Error handling guildMemberAdd for ${member.user.tag}: ${error.message}`, 'ERROR');
        await notifyAdminsForManualIntervention(member, `guildMemberAdd handler error: ${error.message}`);
    }
});



// Start the Discord bot
if (TOKEN) {
    client.login(TOKEN);
} else {
    log('No Discord token provided. Please set the DISCORD_TOKEN environment variable.', 'ERROR');
}