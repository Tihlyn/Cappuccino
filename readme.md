# Cappuccino

A Discord bot designed for Final Fantasy XIV communities, featuring event management, PvP calculations, automatic FC member verification, and utility functions.
Half assed by April Macchiato@Saggitarius

## Features

### 🎯 Event Management
- Create and manage FF14 events (raids, trials, mount farms, etc.)
- Supports multiple event types: Maps, Extreme Trials, Savage Raids, Ultimate Raids, Variant Dungeons, Mount Farm, Occult Crescent, Blue Mage Skill Farm, Minion Farm, Treasure Trove Farm, Deep Dungeon, and Other
- Automated participant tracking with reactions
- Flexible group compositions: Standard (2/2/4), Non-standard (any roles, 8 max), Light party (4 max)
- Reminder system (24h, 12h, 1h before events)
- DM notifications for registrations and cancellations
- **Change Time functionality** - Event organizers can change event time with automatic participant notifications
- Timezone support: UTC, BST (British Summer Time), CET (Central European Time)
- Role-based participation with FFXIV class selection
- Auto-pruning of DMs for completed events

### 🏰 FFXIV FC Member Verification
- Automatic member verification when users join the server
- Prompts new members for their FFXIV Lodestone character link via DM
- Fetches and caches FC member list from Lodestone (refreshed every 24 hours)
- Automatically assigns roles based on FC membership:
  - FC members get special role and their character name as display name
  - Non-FC members get a different role
- Fallback to welcome channel if DMs are disabled
- Admin notifications for manual intervention when needed

### 📊 Marketboard Analysis
- **NEW**: FFXIV market price analysis and predictions
- Search items by name in multiple languages (EN, FR, DE)
- Fuzzy search with autocomplete for easy item discovery
- Real-time market data from Universalis API
- Price history analysis with visual charts
- 7-day price predictions using Holt's Exponential Smoothing
- Trend analysis (Rising ↗️, Falling ↘️, Stable ↔️)
- Current listings with top 5 cheapest prices
- Cross-world market data support

### ⚔️ PvP Calculator
- Calculate Malmstone requirements between PvP levels
- Shows matches needed for different game modes
- Supports Crystalline Conflict, Frontline, and Rival Wings

### 🎲 Dice Rolling
- Animated dice rolling with visual effects
- Support for custom dice sides (2-100)
- Multiple dice rolling (up to 10)
- Fun result messages and statistics

### 🎮 Trivia
- Starts a session of 10 questions from a selected category
- Multiple categories: Movies, Music, Television, Video Games, Japanese Anime & Manga
- Keeps track of answers and score for participants
- Has a leaderboard at the end
- Trivia questions are pruned from the channel after 1 hour
- Locks answers to prevent switching, and disables choices when the next question is up
- Notify users with ephemeral messages if they have the correct answer and gives them the correct one
- Session management with purge and list commands

## Project Structure

```
Cappuccino/
├── bot.js                      # Main bot file - event management, FC verification, commands
├── db.js                       # Database module for trivia questions
├── quizz.js                    # Trivia game module with session management
├── package.json                # Project dependencies and scripts
├── modules/
│   └── marketboard.js          # Marketboard command handler and orchestration
├── services/
│   ├── xivapi.js              # XIVAPI integration for item search (multilingual)
│   ├── universalis.js         # Universalis API for market data
│   ├── market-analyzer.js     # Market analysis and price predictions
│   └── chart-generator.js     # Price history chart generation
├── utils/
│   └── logger.js              # Winston logging utility
├── docs/
│   ├── ARCHITECTURE.md        # Marketboard module architecture documentation
│   └── MARKETBOARD.md         # Marketboard usage and API documentation
└── logs/
    ├── error.log              # Error logs
    └── combined.log           # Combined logs

External Dependencies:
- Redis (required for event reminders and caching)
- SQLite (trivia.db - for trivia questions storage)
```

## Setup

### Prerequisites
- Node.js (v16 or higher)
- Redis server
- Discord application with bot token

### Installation

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/Tihlyn/Cappuccino.git
cd Cappuccino
npm install
```

2. Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
AUTHORIZED_USERS=user_id_1,user_id_2,user_id_3
SERVER_ROLE_ID=server_role_id
EVENT_CHANNEL_ID=channel_id_for_events
WELC_CH_ID=welcome_channel_id
FC_MEMBER_ROLE_ID=role_id_for_fc_members
NON_FC_MEMBER_ROLE_ID=role_id_for_non_fc_members
ADMIN_ROLE_IDS=admin_role_id_1,admin_role_id_2
FFXIV_FC_URL=https://eu.finalfantasyxiv.com/lodestone/freecompany/YOUR_FC_ID/member
```

**Note**: To use the FC verification feature, you need to set the `FFXIV_FC_URL` environment variable. See the [FC Member Verification Configuration](#fc-member-verification-configuration) section below for details.

3. Start Redis server:

I recommend running redis as a container for safety and ease of use

## Option 1: Local Redis Installation

### Windows (Using WSL2 - Recommended)

1. **Install WSL2 if you haven't already:**
```bash
# Run in PowerShell as Administrator
wsl --install
```

2. **Install Redis in WSL2:**
```bash
# Update packages
sudo apt update

# Install Redis
sudo apt install redis-server

# Start Redis service
sudo service redis-server start

# Test Redis is working
redis-cli ping
# Should return: PONG
```

3. **Make Redis start automatically:**
```bash
# Add to ~/.bashrc
echo "sudo service redis-server start" >> ~/.bashrc
```

### macOS

1. **Using Homebrew (Recommended):**
```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Redis
brew install redis

# Start Redis service
brew services start redis

# Test Redis is working
redis-cli ping
# Should return: PONG
```

### Linux (Ubuntu/Debian)

```bash
# Update packages
sudo apt update

# Install Redis
sudo apt install redis-server

# Start and enable Redis service
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Test Redis is working
redis-cli ping
# Should return: PONG
```

## Option 2: Docker Redis (Cross-Platform)

### Basic Docker Setup

1. **Install Docker Desktop** from [docker.com](https://www.docker.com/products/docker-desktop/)

2. **Run Redis container:**
```bash
# Run Redis in detached mode with persistence
docker run --name redis-bullmq -p 6379:6379 -d redis:7-alpine redis-server --appendonly yes

# Test connection
docker exec -it redis-bullmq redis-cli ping
# Should return: PONG
```

### Docker Compose (Recommended for Development)

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    container_name: redis-bullmq
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped

volumes:
  redis-data:
```

Start with:
```bash
docker-compose up -d
```

## 4. Run the bot:
```bash
node bot.js
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token from the Developer Portal |
| `CLIENT_ID` | Your Discord application ID |
| `AUTHORIZED_USERS` | Comma-separated list of user IDs who can create events, list active events and purge them (debug) |
| `EVENT_CHANNEL_ID` | Channel ID where events will be posted |
| `SERVER_ROLE_ID` | In case you want to use server roles instead of specific userIDs to limit who can create events |
| `WELC_CH_ID` | Welcome channel ID for FC verification (fallback if DMs fail) |
| `FC_MEMBER_ROLE_ID` | Role ID assigned to verified FC members |
| `NON_FC_MEMBER_ROLE_ID` | Role ID assigned to non-FC members |
| `ADMIN_ROLE_IDS` | Comma-separated role IDs for admin notifications during verification failures |
| `FFXIV_FC_URL` | (Optional) URL to your Free Company's Lodestone member page. See [FC Member Verification Configuration](#fc-member-verification-configuration) section |

## Commands

### `/create-event`
Create a new FF14 event with the following options:
- **Type**: Maps, Extreme Trials, Savage Raids, Mount Farm, etc.
- **DateTime**: Format as `YYYY-MM-DD HH:MM` (UTC)
- **Description**: Optional additional details

```
/create-event type:savage_raids datetime:2024-12-25 20:00 description:P1S-P4S weekly clear
```

### `/pvp`
Calculate PvP Malmstone requirements:
- **Current Level**: Your current PvP level (1-40)
- **Goal Level**: Target PvP level (1-40)
- **Current Progress**: Optional XP progress in current level

```
/pvp current_level:15 goal_level:20 current_progress:5000
```

### `/roll`
Roll dice with animation:
- **Sides**: Number of sides (default: 6, max: 100)
- **Count**: Number of dice (default: 1, max: 10)

```
/roll sides:20 count:3
```

### `/trivia`
Starts a trivia with the following options:
- **Category**: Movies, Music, Television, Games, Anime & Manga
- **Time**: Amount of time per question, 10s, 30s, 60s

### `/market`
Analyze FFXIV market prices and get predictions:
- **Item**: Item name to search (supports EN, FR, DE with autocomplete)
- **World**: Server world name (optional, default: Sagittarius)
- **Language**: Item language (optional, default: English) - supports English, Français, Deutsch

**Example:**
```
/market item:Megapotion world:Phoenix language:en
```

**Features:**
- Real-time market data and price history
- 7-day price predictions using Holt's Exponential Smoothing
- Visual price history charts
- Current listings with top 5 cheapest prices
- Trend analysis (Rising ↗️, Falling ↘️, Stable ↔️)

## FC Member Verification Configuration

The FC (Free Company) member verification feature uses a hardcoded URL by default in `bot.js`. To make this configurable:

### Converting Hardcoded FC URL to Environment Variable

1. **Find your FC's Lodestone URL:**
   - Visit [FFXIV Lodestone](https://eu.finalfantasyxiv.com/lodestone/)
   - Search for your Free Company
   - Navigate to the Members page
   - Copy the URL (it should look like: `https://eu.finalfantasyxiv.com/lodestone/freecompany/YOUR_FC_ID/member`)

2. **Add to your `.env` file:**
   ```env
   FFXIV_FC_URL=https://eu.finalfantasyxiv.com/lodestone/freecompany/YOUR_FC_ID/member
   ```

3. **Update bot.js to use the environment variable:**
   - Locate line 28 in `bot.js`: 
     ```javascript
     const FFXIV_FC_URL = 'https://eu.finalfantasyxiv.com/lodestone/freecompany/9279667032196922298/member';
     ```
   - Replace it with:
     ```javascript
     const FFXIV_FC_URL = process.env.FFXIV_FC_URL || 'https://eu.finalfantasyxiv.com/lodestone/freecompany/9279667032196922298/member';
     ```

This allows the bot to use your environment variable if set, while falling back to the default if not configured.

## Populating the Trivia Database

The trivia feature requires a SQLite database (`trivia.db`) with questions. The database structure is defined in `db.js`.

### Database Schema

The trivia database has one table: `trivia_questions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key (auto-increment) |
| `category` | TEXT | Question category (must match allowed categories) |
| `question` | TEXT | The question text |
| `option1` | TEXT | First answer option |
| `option2` | TEXT | Second answer option |
| `option3` | TEXT | Third answer option |
| `option4` | TEXT | Fourth answer option |
| `correct_index` | INTEGER | Index of correct answer (0-3) |

### Allowed Categories

Based on `db.js`, the following categories are allowed:
- `Entertainment: Film`
- `Entertainment: Music`
- `Entertainment: Television`
- `Entertainment: Video Games`
- `Entertainment: Japanese Anime & Manga`

### Adding Questions to the Database

**Method 1: Using Node.js Script**

Create a script to populate questions:

```javascript
const db = require('./db');

// Example: Adding a question
const question = {
    category: "Entertainment: Video Games",
    question: "What is the capital city of Eorzea in Final Fantasy XIV?",
    options: ["Ul'dah", "Gridania", "Limsa Lominsa", "Ishgard"],
    correct_index: 0 // Ul'dah is correct
};

db.addQuestion(question);
console.log("Question added successfully!");
```

**Method 2: Using SQLite Directly**

```bash
sqlite3 trivia.db

INSERT INTO trivia_questions (category, question, option1, option2, option3, option4, correct_index)
VALUES (
    'Entertainment: Video Games',
    'What is the capital city of Eorzea in Final Fantasy XIV?',
    'Ul''dah',
    'Gridania',
    'Limsa Lominsa',
    'Ishgard',
    0
);
```

**Method 3: Bulk Import from JSON**

Create a file `import-trivia.js`:

```javascript
const db = require('./db');
const fs = require('fs');

// Load questions from JSON file
const questions = JSON.parse(fs.readFileSync('trivia-questions.json', 'utf8'));

questions.forEach(q => {
    try {
        db.addQuestion(q);
        console.log(`Added: ${q.question}`);
    } catch (error) {
        console.error(`Failed to add question: ${error.message}`);
    }
});

console.log('Import complete!');
```

Example `trivia-questions.json`:
```json
[
    {
        "category": "Entertainment: Video Games",
        "question": "What is the maximum level in FFXIV as of Endwalker?",
        "options": ["80", "90", "100", "70"],
        "correct_index": 1
    },
    {
        "category": "Entertainment: Music",
        "question": "Who composed the Final Fantasy main theme?",
        "options": ["Nobuo Uematsu", "Masayoshi Soken", "Yoko Shimomura", "Koji Kondo"],
        "correct_index": 0
    }
]
```

Run with: `node import-trivia.js`

### Validation Rules

The `db.js` module validates all questions before insertion:
- Category must be one of the allowed categories
- Question text must be at least 5 characters
- Exactly 4 options must be provided
- `correct_index` must be between 0 and 3

### Verifying Your Database

Check your questions:

```javascript
const db = require('./db');

// Get all questions
const questions = db.getAllQuestions();
console.log(`Total questions: ${questions.length}`);

// Get questions by category
const gameQuestions = db.getQuestionsByCategory("Entertainment: Video Games", 10);
console.log(`Game questions: ${gameQuestions.length}`);

// Get distinct categories
const categories = db.getDistinctCategories();
console.log('Categories:', categories);
```

## Key Functions
- `handleCreateEvent()` - Creates new events and posts to designated channel
- `handleButtonInteraction()` - Processes participation, role changes, time changes, and deletion buttons
- `handleModalSubmission()` - Handles modal form submissions for event time changes
- `scheduleReminders()` - Sets up automated reminder jobs
- `createEventEmbed()` - Generates event display embeds

### Data Management
- `saveEventToRedis()` - Persists event data
- `getEventFromRedis()` - Retrieves event information
- `deleteEventFromRedis()` - Removes events from storage

## Event Types Supported

- Maps
- Extreme Trials
- Savage Raids
- Ultimate Raids
- Variant Dungeons
- Mount Farm
- Occult Crescent
- Blue Mage Skill Farm
- Minion Farm
- Treasure Trove Farm
- Deep Dungeon
- Other

## Reminder System

The bot uses BullMQ and Redis to manage automated reminders:
- Participants receive DMs 24 hours, 12 hours, and 1 hour before events
- Reminders are automatically cancelled if events are deleted
- Users are notified via DM when events are cancelled

## DM Auto-Pruning

The bot automatically manages DM messages to keep users' inboxes clean:
- **Automatically removes** DMs for completed events (registration confirmations, withdrawals, cancellations, time changes)
- **Preserves** DMs for upcoming events (24h/12h/1h reminders)
- **Preserves** role and class change notifications as they remain relevant
- DM cleanup occurs 5 minutes after events complete

## FFXIV FC Member Verification

The bot automatically verifies new server members against your Free Company roster:

### How it Works
1. When a user joins the server, they receive a DM asking for their FFXIV Lodestone character link
2. The bot extracts the character ID from the link and checks it against cached FC member data  
3. FC members get assigned the FC member role and their character name as display name
4. Non-FC members get assigned a different role
5. If DMs fail, the verification falls back to the welcome channel with ephemeral messages

### FC Data Caching
- FC member data is cached in Redis for 24 hours to avoid rate limits
- Cache is automatically refreshed every 24 hours
- Fallback to cached data if Lodestone is unreachable
- FC URL can be configured via environment variable (see [FC Member Verification Configuration](#fc-member-verification-configuration))

### Manual Intervention
- If verification fails or character ID cannot be extracted, admins are notified via DM
- Admins can then manually assign roles as needed
- All verification attempts are logged for debugging

## Permissions Required

The bot needs the following Discord permissions:
- Send Messages
- Use Slash Commands
- Embed Links
- Add Reactions
- Send Messages in DMs
- Read Message History
- Manage Roles (for FC verification)
- Change Nicknames (for FC member names)
- View Server Members (for guildMemberAdd events)

## Logging

The bot logs all activities to both console and `bot.log` file, including:
- Command usage
- Event creation/deletion
- Reminder notifications
- Error tracking

## Troubleshooting

### Common Issues

**Bot not responding to commands:**
- Verify the bot token is correct
- Check if slash commands are registered
- Ensure bot has proper permissions in the server

**Events not posting:**
- Verify `EVENT_CHANNEL_ID` is correct
- Check if bot has permissions in the target channel

**Reminders not working:**
- Ensure Redis server is running
- Check Redis connection logs

**Authorization errors:**
- Verify user IDs in `AUTHORIZED_USERS` are correct
- User IDs should be comma-separated without spaces

## Contributing

Feel free to submit issues and enhancement requests!


