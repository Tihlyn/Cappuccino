const logger = require('../utils/logger');

/**
 * Market Analyzer - Analyzes market data and generates predictions
 */
class MarketAnalyzer {
    constructor(universalisService) {
        if (!universalisService) {
            throw new Error('UniversalisService is required for MarketAnalyzer');
        }
        this.universalis = universalisService;
        logger.info('MarketAnalyzer initialized');
    }

    /**
     * Analyze item market data and generate predictions
     * @param {number} itemId - Item ID
     * @param {string} itemName - Item name
     * @param {string} world - Server world
     * @returns {Promise<Object>} Analysis results with predictions
     */
    async analyzeItem(itemId, itemName, world = 'Sagittarius') {
        if (!itemId || !Number.isInteger(itemId) || itemId <= 0) {
            logger.warn('analyzeItem called with invalid itemId', { itemId });
            throw new Error('Invalid item ID provided');
        }

        if (!itemName || typeof itemName !== 'string') {
            logger.warn('analyzeItem called without item name', { itemId });
            itemName = `Item ${itemId}`;
        }

        logger.info('Analyzing item', { itemId, itemName, world });

        try {
            // Fetch market data
            const marketData = await this.universalis.getItemHistory(itemId, world);
            
            if (!marketData) {
                throw new Error('Failed to retrieve market data');
            }

            // Process price history
            const priceHistory = this.universalis.processPriceHistory(marketData);
            
            if (priceHistory.length < 14) {
                logger.warn('Insufficient price history for analysis', { 
                    itemId, 
                    historyLength: priceHistory.length 
                });
                throw new Error('Insufficient price history for analysis (minimum 14 entries required)');
            }

            const prices = priceHistory.map(entry => entry.price);
            
            logger.debug('Analyzing prices', { 
                itemId, 
                priceCount: prices.length,
                samplePrices: prices.slice(0, 5) 
            });

            // Generate predictions
            let predictions;
            let predictionMethod;

            try {
                // Use Holt's exponential smoothing (with trend)
                const alpha = 0.3; // Level smoothing parameter
                const beta = 0.2;  // Trend smoothing parameter
                
                predictions = this.generateHoltSmoothing(prices, alpha, beta, 7);
                predictionMethod = "Holt's Exponential Smoothing";
                
                logger.debug('Holt smoothing successful', { 
                    itemId, 
                    predictionCount: predictions.length 
                });

            } catch (error) {
                logger.warn('Holt smoothing failed, falling back to simple smoothing', { 
                    itemId, 
                    error: error.message 
                });
                
                // Fallback to simple exponential smoothing
                try {
                    const alpha = 0.3;
                    predictions = this.generateSimpleExpSmoothing(prices, alpha, 7);
                    predictionMethod = 'Simple Exponential Smoothing';
                    
                    logger.debug('Simple smoothing successful', { itemId });
                } catch (fallbackError) {
                    logger.error('All prediction methods failed', { 
                        itemId, 
                        error: fallbackError.message 
                    });
                    throw new Error('All prediction methods failed');
                }
            }

            // Calculate statistics
            const currentPrice = marketData.averagePrice || marketData.currentAveragePrice || 0;
            const recentPrices = prices.slice(-5);
            const avgRecentPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
            const trend = this.calculateTrend(prices);
            
            // Get current listings
            const currentListings = this.universalis.getCurrentListings(marketData);

            const analysis = {
                itemId,
                itemName,
                world,
                currentPrice,
                avgRecentPrice,
                predictions: predictions || [],
                trend,
                dataPoints: prices.length,
                lastUpdated: new Date(marketData.lastUploadTime).toLocaleString(),
                predictionMethod,
                currentListings: currentListings.slice(0, 5), // Top 5 cheapest listings
                minPrice: currentListings.length > 0 ? currentListings[0].price : null,
                maxPrice: prices.length > 0 ? Math.max(...prices) : null,
                priceHistory: priceHistory, // Full price history for graphing
            };

            logger.info('Item analysis completed', { 
                itemId, 
                itemName, 
                trend, 
                currentPrice,
                predictionMethod 
            });

            return analysis;

        } catch (error) {
            logger.error('Analysis failed', { 
                itemId, 
                itemName, 
                error: error.message,
                stack: error.stack 
            });
            throw new Error(`Analysis failed: ${error.message}`);
        }
    }

    /**
     * Generate predictions using Holt's exponential smoothing (level + trend)
     * @param {Array<number>} prices - Historical prices
     * @param {number} alpha - Level smoothing parameter
     * @param {number} beta - Trend smoothing parameter
     * @param {number} forecastDays - Number of days to forecast
     * @returns {Array<number>} Predicted prices
     */
    generateHoltSmoothing(prices, alpha = 0.3, beta = 0.2, forecastDays = 7) {
        if (!prices || !Array.isArray(prices) || prices.length < 3) {
            logger.warn('generateHoltSmoothing: insufficient data', { 
                pricesLength: prices?.length 
            });
            return [];
        }

        // Validate parameters
        if (alpha <= 0 || alpha >= 1 || beta <= 0 || beta >= 1) {
            logger.warn('Invalid smoothing parameters, using defaults', { alpha, beta });
            alpha = 0.3;
            beta = 0.2;
        }

        try {
            // Initialize level and trend
            let level = prices[0];
            let trend = prices[1] - prices[0];
            
            // Apply Holt's smoothing
            for (let i = 1; i < prices.length; i++) {
                const prevLevel = level;
                level = alpha * prices[i] + (1 - alpha) * (level + trend);
                trend = beta * (level - prevLevel) + (1 - beta) * trend;
            }
            
            // Generate forecasts
            const predictions = [];
            for (let i = 1; i <= forecastDays; i++) {
                const forecast = level + (i * trend);
                predictions.push(Math.max(1, Math.round(forecast)));
            }
            
            logger.debug('Holt smoothing predictions generated', { 
                predictionCount: predictions.length 
            });
            
            return predictions;

        } catch (error) {
            logger.error('Error in Holt smoothing', { 
                error: error.message,
                pricesLength: prices.length 
            });
            throw error;
        }
    }

    /**
     * Generate predictions using simple exponential smoothing (level only)
     * @param {Array<number>} prices - Historical prices
     * @param {number} alpha - Smoothing parameter
     * @param {number} forecastDays - Number of days to forecast
     * @returns {Array<number>} Predicted prices
     */
    generateSimpleExpSmoothing(prices, alpha = 0.3, forecastDays = 7) {
        if (!prices || !Array.isArray(prices) || prices.length < 2) {
            logger.warn('generateSimpleExpSmoothing: insufficient data', { 
                pricesLength: prices?.length 
            });
            return [];
        }

        // Validate parameter
        if (alpha <= 0 || alpha >= 1) {
            logger.warn('Invalid smoothing parameter, using default', { alpha });
            alpha = 0.3;
        }

        try {
            let smoothed = prices[0];
            
            // Apply simple exponential smoothing
            for (let i = 1; i < prices.length; i++) {
                smoothed = alpha * prices[i] + (1 - alpha) * smoothed;
            }
            
            // Generate flat forecasts (no trend)
            const predictions = [];
            for (let i = 0; i < forecastDays; i++) {
                predictions.push(Math.round(smoothed));
            }
            
            logger.debug('Simple smoothing predictions generated', { 
                predictionCount: predictions.length 
            });
            
            return predictions;

        } catch (error) {
            logger.error('Error in simple smoothing', { 
                error: error.message,
                pricesLength: prices.length 
            });
            throw error;
        }
    }

    /**
     * Calculate price trend
     * @param {Array<number>} prices - Historical prices
     * @returns {string} Trend indicator
     */
    calculateTrend(prices) {
        if (!prices || !Array.isArray(prices) || prices.length < 2) {
            logger.debug('calculateTrend: insufficient data');
            return 'Unknown';
        }

        try {
            const recent = prices.slice(-5);
            const older = prices.slice(-10, -5);

            if (older.length === 0) {
                logger.debug('calculateTrend: insufficient historical data');
                return 'Insufficient data';
            }

            const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
            const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

            const change = ((recentAvg - olderAvg) / olderAvg) * 100;

            if (change > 5) return 'Rising ↗️';
            if (change < -5) return 'Falling ↘️';
            return 'Stable ↔️';

        } catch (error) {
            logger.error('Error calculating trend', { error: error.message });
            return 'Unknown';
        }
    }
}

module.exports = MarketAnalyzer;
