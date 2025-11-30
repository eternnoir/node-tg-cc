# node-tg-cc

A Node.js/TypeScript implementation of [tg-cc](https://github.com/eternnoir/tg-cc) - Telegram bot integration with Claude Code using the Claude Agent SDK.

## Features

- 🤖 **Multi-bot Support** - Run multiple bots simultaneously, each with its own project directory
- 💬 **Session Management** - Persistent conversations with session resume capability
- 👥 **User Whitelist** - Control who can access each bot
- 📁 **File Support** - Handle photos, documents, audio, video, and voice messages
- 💾 **SQLite Persistence** - Sessions are stored in SQLite for durability
- 🔧 **Flexible Configuration** - Environment variables or .env files
- 📦 **NPX Support** - Run directly with `npx node-tg-cc`

## Requirements

- Node.js 18.0.0 or higher
- Claude CLI installed and configured (`npm install -g @anthropic-ai/claude-code`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## Installation

### Using npx (recommended)

```bash
# Run directly without installation
npx node-tg-cc

# With custom .env file
npx node-tg-cc --env /path/to/.env
```

### Global Installation

```bash
npm install -g node-tg-cc

# Then run
tg-cc
```

### Local Installation

```bash
npm install node-tg-cc

# Run via npx
npx tg-cc
```

## Configuration

### Environment Variables

Create a `.env` file in your working directory:

```bash
# Copy the example configuration
cp .env.example .env
```

#### Single Bot Configuration

```env
# Required
BOT_TOKEN=your_telegram_bot_token
BOT_WORKING_DIR=/path/to/your/project

# Optional
BOT_NAME=MyClaudeBot
BOT_WHITELIST=123456789,987654321
BOT_CLAUDE_ARGS=--model claude-sonnet-4-20250514
BOT_TEMP_DIR=/tmp/tg-cc

# Logging
LOG_LEVEL=info
LOG_FORMAT=console

# Database
DB_PATH=sessions.db
```

#### Multiple Bots Configuration

```env
BOT_COUNT=2

# Bot 1
BOT_1_TOKEN=first_bot_token
BOT_1_WORKING_DIR=/path/to/project1
BOT_1_NAME=ProjectOneBot
BOT_1_WHITELIST=123456789

# Bot 2
BOT_2_TOKEN=second_bot_token
BOT_2_WORKING_DIR=/path/to/project2
BOT_2_NAME=ProjectTwoBot
BOT_2_WHITELIST=123456789,987654321
```

### Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token from BotFather | Required |
| `BOT_WORKING_DIR` | Working directory for Claude Code | Required |
| `BOT_NAME` | Bot identifier name | `BOT` |
| `BOT_WHITELIST` | Comma-separated allowed user IDs | Empty (all allowed) |
| `BOT_CLAUDE_ARGS` | Additional Claude CLI arguments | Empty |
| `BOT_TEMP_DIR` | Temporary directory for uploads | `{workingDir}/.tg-cc-temp` |
| `LOG_LEVEL` | Logging level | `info` |
| `LOG_FORMAT` | Log format (`console` or `json`) | `console` |
| `DB_PATH` | SQLite database path | `sessions.db` |

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and show welcome message |
| `/new` | Start a new conversation (clears context) |
| `/clear` | Clear the current session completely |
| `/status` | Show current session status |
| `/help` | Show help message |

## Usage Examples

### Basic Usage

```bash
# Set environment variables
export BOT_TOKEN=your_token
export BOT_WORKING_DIR=/path/to/project

# Run the bot
npx node-tg-cc
```

### With .env File

```bash
# Create .env file
cat > .env << EOF
BOT_TOKEN=your_token
BOT_WORKING_DIR=/path/to/project
BOT_WHITELIST=123456789
EOF

# Run the bot
npx node-tg-cc
```

### Docker

```dockerfile
FROM node:20-slim

WORKDIR /app

RUN npm install -g node-tg-cc @anthropic-ai/claude-code

COPY .env .

CMD ["tg-cc"]
```

## Programmatic Usage

You can also use this package programmatically:

```typescript
import {
  loadFromEnv,
  initLogger,
  SQLiteStorage,
  BotManager
} from 'node-tg-cc';

// Load configuration
const config = loadFromEnv();

// Initialize logger
initLogger(config.logLevel, config.logFormat);

// Initialize storage
const storage = new SQLiteStorage(config.dbPath);

// Create bot manager
const manager = new BotManager(storage);

// Add bots
for (const botConfig of config.bots) {
  manager.addBot(botConfig);
}

// Start all bots
await manager.startAll();

// Graceful shutdown
process.on('SIGINT', () => {
  manager.stopAll();
  storage.close();
});
```

## Security Considerations

⚠️ **Important**: When the whitelist is empty, all users can use the bot. This is not recommended for production use.

- Always set `BOT_WHITELIST` with authorized user IDs in production
- Keep your `.env` file secure and never commit it to version control
- Use separate bot tokens for development and production

## How to Get Your Telegram User ID

1. Start a chat with [@userinfobot](https://t.me/userinfobot)
2. Send any message
3. The bot will reply with your user ID

## Development

```bash
# Clone the repository
git clone https://github.com/eternnoir/node-tg-cc.git
cd node-tg-cc

# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Credits

- Original Go implementation: [tg-cc](https://github.com/eternnoir/tg-cc)
- [Claude Agent SDK](https://github.com/anthropics/claude-code)
- [Telegraf](https://github.com/telegraf/telegraf)
