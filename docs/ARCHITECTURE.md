# Marketboard Module Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         Discord Bot                            │
│                         (bot.js)                               │
└───────────────────────┬────────────────────────────────────────┘
                        │
                        │ imports & initializes
                        ▼
┌────────────────────────────────────────────────────────────────┐
│                   Marketboard Module                           │
│                 (modules/marketboard.js)                       │
│                                                                │
│  • Handles /market command                                     │
│  • Manages autocomplete interactions                           │
│  • Coordinates service calls                                   │
│  • Formats Discord embeds                                      │
└─────────┬────────────────┬─────────────────┬───────────────────┘
          │                │                 │
          │                │                 │
          ▼                ▼                 ▼
┌─────────────────┐ ┌──────────────┐ ┌─────────────────┐
│  XIVAPI Service │ │ Universalis  │ │ Market Analyzer │
│ (services/      │ │   Service    │ │ (services/      │
│  xivapi.js)     │ │ (services/   │ │  market-       │
│                 │ │  universalis │ │  analyzer.js)   │
│ • Item search   │ │  .js)        │ │                 │
│ • Fuzzy match   │ │              │ │ • Price analysis│
│ • Multi-lang    │ │ • Market data│ │ • Predictions   │
│ • ID lookup     │ │ • History    │ │ • Trend calc    │
│ • Caching       │ │ • Listings   │ │ • Holt smooth   │
└────────┬────────┘ └──────┬───────┘ └─────────┬───────┘
         │                 │                    │
         │                 │                    │
         └─────────────────┴────────────────────┘
                           │
                           │ all use
                           ▼
                  ┌────────────────┐
                  │ Winston Logger │
                  │ (utils/        │
                  │  logger.js)    │
                  │                │
                  │ • Structured   │
                  │ • Rotation     │
                  │ • Levels       │
                  └────────────────┘

External APIs:
┌────────────┐     ┌────────────────┐
│  XIVAPI    │────▶│ Item Database  │
│  xivapi.com│     │ EN, FR, DE     │
└────────────┘     └────────────────┘

┌────────────┐     ┌────────────────┐
│ Universalis│────▶│ Market Prices  │
│ .app       │     │ All Worlds     │
└────────────┘     └────────────────┘
```

## Data Flow

### User Command Flow
```
1. User types: /market item:Mega...
   ↓
2. Autocomplete triggered (min 2 chars)
   ↓
3. XIVAPIService searches items
   ↓
4. Fuzzy matching applied
   ↓
5. Results cached & shown to user
   ↓
6. User selects: "Megapotion (Medicine)"
   ↓
7. MarketboardModule extracts ID:23167
   ↓
8. UniversalisService fetches market data
   ↓
9. MarketAnalyzer processes data
   ↓
10. Predictions generated (Holt's)
   ↓
11. Embed created & sent to Discord
```

### Caching Strategy
```
┌──────────────────┐
│ XIVAPI Cache     │  24 hours
│ (Item data)      │  In-memory Map
└──────────────────┘

┌──────────────────┐
│ Autocomplete     │  5 minutes
│ Cache            │  In-memory Map
│ (Search results) │
└──────────────────┘

Note: No Redis needed - module is self-contained
```

## Component Responsibilities

### modules/marketboard.js
- **Role**: Orchestrator
- **Responsibilities**: 
  - Command registration
  - Interaction handling
  - Service coordination
  - Response formatting

### services/xivapi.js
- **Role**: Item Discovery
- **Responsibilities**:
  - Item search (multilingual)
  - Fuzzy matching
  - Item ID lookup
  - Data caching

### services/universalis.js
- **Role**: Market Data Provider
- **Responsibilities**:
  - Market history fetching
  - Price data processing
  - Current listings extraction
  - Error handling

### services/market-analyzer.js
- **Role**: Data Processor
- **Responsibilities**:
  - Statistical analysis
  - Price predictions
  - Trend calculation
  - Algorithm selection

### utils/logger.js
- **Role**: Logging Infrastructure
- **Responsibilities**:
  - Structured logging
  - Log rotation
  - Level management
  - Format handling

## Key Design Decisions

1. **Service-oriented architecture**: Each service has a single responsibility
2. **No shared state**: Services are stateless except for caching
3. **Defensive programming**: Validate all inputs, handle all errors
4. **Promise-based**: All async operations use proper promises
5. **Logging first**: Log everything for debugging and monitoring
6. **In-memory caching**: Fast, simple, no external dependencies
7. **Graceful degradation**: Fallback algorithms if primary fails

## Testing

Run the test suite:
```bash
node test-marketboard.js
```

Tests cover:
- ✓ XIVAPI search (EN, FR, DE)
- ✓ Item lookup by ID
- ✓ Exact match finding
- ✓ Universalis data fetching
- ✓ Price history processing
- ✓ Market analysis
- ✓ Predictions generation
