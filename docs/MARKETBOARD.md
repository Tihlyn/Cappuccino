# Marketboard Module Documentation

## Overview

The Marketboard module provides FFXIV market analysis functionality integrated into the Serenity Discord bot. It allows users to search for items by name in multiple languages (EN, FR, DE) and get detailed market analysis with price predictions.

## Architecture

The module follows a clean, service-oriented architecture:

```
modules/marketboard.js          # Main module (command handler + autocomplete)
├── services/xivapi.js          # XIVAPI integration for item search
├── services/universalis.js     # Universalis API for market data
├── services/market-analyzer.js # Market analysis and predictions
├── services/chart-generator.js # Price history chart generation
└── utils/logger.js             # Winston logging utility
```

## Features

### 1. Multilingual Item Search
- **Supports**: English, French, and German
- **Fuzzy Matching**: Uses Fuse.js for intelligent search
- **Autocomplete**: Discord native autocomplete for easy item selection
- **Exact Match**: Finds exact matches across all supported languages

### 2. Market Analysis
- **Price History**: Retrieves up to 100 recent market transactions
- **Current Listings**: Shows top 5 cheapest current listings
- **Price Trends**: Calculates trend (Rising ↗️, Falling ↘️, Stable ↔️)
- **Predictions**: 7-day price predictions using Holt's Exponential Smoothing (formatted 4 per line)
- **Visual Charts**: Generates price history charts with predictions overlay

### 3. Modern JavaScript Patterns
- **Defensive Programming**: Input validation at every level
- **Proper Error Handling**: Try-catch blocks with meaningful error messages
- **Promise-based**: All async operations use proper promises
- **Caching**: Smart caching for XIVAPI and autocomplete results

### 4. Winston Logging
- **Structured Logging**: JSON format for machine parsing
- **Log Levels**: DEBUG, INFO, WARN, ERROR
- **Log Rotation**: Automatic log file rotation (5MB per file, 5 files max)
- **Console Output**: Colorized output for development

## Usage

### Discord Command

```
/market item:<item_name> [world:<server_world>]
```

**Parameters:**
- `item` (required): Item name - supports autocomplete
- `world` (optional): Server world name (default: Sagittarius)

**Example:**
```
/market item:Megapotion world:Phoenix
```

### Autocomplete Flow

1. User types at least 3 characters (prevents premature triggering)
2. XIVAPI performs fresh search for matching items
3. Results filtered by marketable items only
4. Fuzzy matching applied for relevance (min 3 chars)
5. Top 25 results shown in autocomplete
6. Results cached after search completes (5 minutes)

### Search Flow

1. User searches by item name (any language)
2. XIVAPI finds matching items
3. Item ID extracted from selection
4. Universalis API fetches market data
5. Market analyzer processes data
6. Predictions generated using Holt's smoothing
7. Results displayed in rich embed

## API Integration

### XIVAPI Service

**Purpose**: Search and retrieve FFXIV item data using V2 live API endpoints

**API**: Uses https://v2.xivapi.com/api/
- Search endpoint: `/search?sheets=Item&query=...&fields=...&limit=...`
- Get by ID endpoint: `/sheet/Item/{id}?fields=...`

**Methods:**
- `searchItems(query, limit)`: Search for items by name
- `getItemById(itemId)`: Get item details by ID
- `findExactMatch(itemName)`: Find exact match for item name
- `clearCache()`: Clear item cache

**Caching**: 24-hour cache for item data

**Implementation**: Direct HTTP calls using axios (no npm package required)

### Universalis Service

**Purpose**: Fetch market data from Universalis API

**Methods:**
- `getItemHistory(itemId, world, entries)`: Get price history
- `processPriceHistory(data)`: Process raw price data
- `getCurrentListings(data)`: Extract current listings
- `isValidWorld(worldName)`: Validate world name

**Features:**
- 10-second timeout
- Defensive error handling
- User-Agent header for API identification

### Market Analyzer

**Purpose**: Analyze market data and generate predictions

**Methods:**
- `analyzeItem(itemId, itemName, world)`: Complete market analysis
- `generateHoltSmoothing(prices, alpha, beta, days)`: Holt's smoothing
- `generateSimpleExpSmoothing(prices, alpha, days)`: Simple smoothing
- `calculateTrend(prices)`: Calculate price trend

**Algorithms:**
1. **Holt's Exponential Smoothing** (primary): Accounts for trend
2. **Simple Exponential Smoothing** (fallback): Basic smoothing

### Chart Generator

**Purpose**: Generate visual price history charts for market analysis

**Methods:**
- `generatePriceChart(priceHistory, predictions, itemName)`: Generate chart as PNG buffer

**Features:**
- 800x400 resolution optimized for Discord
- Dark theme matching Discord's interface
- Cyan solid line for historical prices (last 50 entries)
- Orange dashed line for predictions
- Automatic date formatting on X-axis
- Gil price formatting on Y-axis
- Professional chart styling with Chart.js

**Output Format:**
- PNG image buffer
- Attached to Discord embed
- Non-blocking generation (fails gracefully)

## Configuration

### Environment Variables

No specific environment variables required for the marketboard module. Uses existing bot configuration.

### Logging Configuration

Configured in `utils/logger.js`:
- Log level: `process.env.LOG_LEVEL` (default: 'info')
- Log directory: `logs/`
- Error log: `logs/error.log`
- Combined log: `logs/combined.log`

## Error Handling

### Defensive Programming Practices

1. **Input Validation**:
   - All inputs validated for type and range
   - Invalid inputs return meaningful error messages
   - No assumptions about input data

2. **Null/Undefined Checks**:
   - All API responses checked for null/undefined
   - Default values used where appropriate
   - Optional chaining and nullish coalescing

3. **Try-Catch Blocks**:
   - All async operations wrapped in try-catch
   - Errors logged with context
   - User-friendly error messages

4. **API Failures**:
   - Timeout handling (10s for Universalis)
   - Network error detection
   - Graceful degradation

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "No items found" | Search query too vague or item doesn't exist | Use autocomplete, try different terms |
| "Insufficient price history" | Item has < 14 market transactions | Item not actively traded, can't predict |
| "Universalis API error" | API down or rate limited | Wait and retry, or try different world |
| "Invalid world name" | World name misspelled or doesn't exist | Check spelling, use valid FFXIV world name |

## Performance

### Caching Strategy

1. **XIVAPI Cache**: 24-hour cache for item data (Map-based)
2. **Autocomplete Cache**: 5-minute write-through cache for search results (Map-based)
   - Cache is populated AFTER successful searches
   - Always performs fresh search for user input
   - Cache serves as a backup/reference, not a primary data source
3. **No Redis**: Module uses in-memory caching only

### Optimization

- Parallel processing where possible
- Minimal data transfer (selective columns from XIVAPI)
- Fuzzy matching only on marketable items
- Autocomplete limited to 25 results

## Testing

### Manual Testing

Run the test script:

```bash
node test-marketboard.js
```

This tests:
- XIVAPI search functionality
- Multilingual search (EN, FR, DE)
- Item retrieval by ID
- Universalis market data fetching
- Market analysis and predictions

**Note**: Tests require internet access to xivapi.com and universalis.app

### Integration Testing

Test within Discord:
1. Start the bot: `node bot.js`
2. Use `/market` command
3. Try autocomplete with various search terms
4. Verify results display correctly
5. Test error cases (invalid items, invalid worlds)

## Maintenance

### Updating Dependencies

```bash
npm update winston fuse.js axios chart.js chartjs-node-canvas
```

**Key Dependencies:**
- `axios`: HTTP client for API calls
- `fuse.js`: Fuzzy search for item matching
- `winston`: Logging framework
- `chart.js`: Chart rendering library
- `chartjs-node-canvas`: Server-side chart generation

**Note**: The bot no longer uses the @xivapi/js package. It directly calls the XIVAPI V2 live endpoints using axios.

### Monitoring

Check logs for errors:
```bash
tail -f logs/error.log
tail -f logs/combined.log
```

### Common Issues

1. **XIVAPI Rate Limiting**: Implement exponential backoff if needed
2. **Universalis Timeout**: Increase timeout in `services/universalis.js`
3. **Memory Leaks**: Clear caches periodically using `clearCaches()` method

## Recent Enhancements (2025)

### October 2025 Update
- ✅ **Price History Charts**: Automatically generated visual charts showing price trends
  - Historical data displayed as cyan solid line
  - Predictions shown as orange dashed line
  - Dark theme matching Discord UI
  - 800x400 optimal resolution
- ✅ **Improved Prediction Display**: 7-day predictions now show 4 days per line for better readability
  - Format: `D1: 5,100 | D2: 5,150 | D3: 5,200 | D4: 5,300`
  - More compact and easier to read
- ✅ **Enhanced Item Display**: Guaranteed item name display (never just ID)
  - Proper fallback handling for API failures
  - Ensures user-friendly item identification

## Future Enhancements

Possible improvements:
- [ ] Price alerts (notify when item reaches target price)
- [ ] Cross-world price comparison
- [ ] Data center aggregation
- [ ] More prediction algorithms (ARIMA, Prophet)
- [ ] Recipe profitability calculator
- [ ] Redis-based caching for multi-instance deployments
- [ ] Interactive chart controls (zoom, pan)
- [ ] Export data to CSV/JSON

## Contributing

When modifying the marketboard module:

1. **Follow Patterns**: Use existing patterns for consistency
2. **Add Logging**: Log at appropriate levels (debug, info, warn, error)
3. **Validate Input**: Never trust user input
4. **Handle Errors**: Wrap async operations in try-catch
5. **Test Thoroughly**: Test with various inputs and edge cases
6. **Update Docs**: Keep this documentation up to date

## License

Part of the Serenity Discord bot project.
