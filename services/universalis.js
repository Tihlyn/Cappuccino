const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Universalis API Service for market data
 * Provides market price history and predictions
 */
class UniversalisService {
    constructor() {
        this.baseURL = 'https://universalis.app/api/v2';
        this.defaultWorld = 'Sagittarius'; // Default world
        this.timeout = 10000; // 10 seconds timeout
        
        logger.info('UniversalisService initialized', { defaultWorld: this.defaultWorld });
    }

    /**
     * Get item history from Universalis
     * @param {number} itemId - Item ID
     * @param {string} world - Server world
     * @param {number} entries - Number of history entries to retrieve
     * @returns {Promise<Object>} Market data
     */
    async getItemHistory(itemId, world = this.defaultWorld, entries = 100) {
        if (!itemId || !Number.isInteger(itemId) || itemId <= 0) {
            logger.warn('getItemHistory called with invalid itemId', { itemId });
            throw new Error('Invalid item ID provided');
        }

        if (!world || typeof world !== 'string' || world.trim().length === 0) {
            logger.warn('getItemHistory called with invalid world, using default', { 
                world, 
                defaultWorld: this.defaultWorld 
            });
            world = this.defaultWorld;
        }

        const normalizedWorld = world.trim();
        const maxEntries = Math.min(Math.max(1, entries), 500); // Cap between 1-500

        logger.info('Fetching item history', { 
            itemId, 
            world: normalizedWorld, 
            entries: maxEntries 
        });

        try {
            const url = `${this.baseURL}/${normalizedWorld}/${itemId}`;
            const response = await axios.get(url, {
                params: { entries: maxEntries },
                timeout: this.timeout,
                headers: {
                    'User-Agent': 'Serenity-Discord-Bot/1.0',
                },
            });

            if (!response.data) {
                logger.warn('Empty response from Universalis', { itemId, world: normalizedWorld });
                throw new Error('Empty response from Universalis API');
            }

            logger.info('Item history retrieved', { 
                itemId, 
                world: normalizedWorld,
                historyLength: response.data.recentHistory?.length || 0,
                currentListings: response.data.listings?.length || 0,
            });

            return response.data;

        } catch (error) {
            if (error.response) {
                // Server responded with error status
                logger.error('Universalis API error response', {
                    itemId,
                    world: normalizedWorld,
                    status: error.response.status,
                    statusText: error.response.statusText,
                });
                throw new Error(`Universalis API error: ${error.response.status} ${error.response.statusText}`);
            } else if (error.request) {
                // Request made but no response
                logger.error('No response from Universalis API', {
                    itemId,
                    world: normalizedWorld,
                    error: error.message,
                });
                throw new Error('No response from Universalis API - server may be down');
            } else {
                // Error setting up request
                logger.error('Error setting up Universalis request', {
                    itemId,
                    world: normalizedWorld,
                    error: error.message,
                    stack: error.stack,
                });
                throw new Error(`Failed to fetch data: ${error.message}`);
            }
        }
    }

    /**
     * Process price history from market data
     * @param {Object} data - Market data from Universalis
     * @returns {Array} Processed price history
     */
    processPriceHistory(data) {
        if (!data || typeof data !== 'object') {
            logger.warn('processPriceHistory called with invalid data');
            throw new Error('Invalid market data provided');
        }

        if (!data.recentHistory || !Array.isArray(data.recentHistory) || data.recentHistory.length === 0) {
            logger.warn('No price history available', { 
                itemId: data.itemID,
                worldName: data.worldName 
            });
            throw new Error('No price history available for this item');
        }

        logger.debug('Processing price history', { 
            historyLength: data.recentHistory.length 
        });

        try {
            // Sort by timestamp and extract prices
            const sortedEntries = data.recentHistory
                .filter(entry => entry && typeof entry === 'object')
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                .map(entry => ({
                    price: entry.pricePerUnit || 0,
                    quantity: entry.quantity || 0,
                    timestamp: entry.timestamp || 0,
                    buyerName: entry.buyerName || 'Unknown',
                    hq: entry.hq || false,
                }));

            logger.info('Price history processed', { 
                entriesProcessed: sortedEntries.length 
            });

            return sortedEntries;

        } catch (error) {
            logger.error('Error processing price history', { 
                error: error.message,
                stack: error.stack 
            });
            throw new Error(`Failed to process price history: ${error.message}`);
        }
    }

    /**
     * Get current listings for an item
     * @param {Object} data - Market data from Universalis
     * @returns {Array} Current listings
     */
    getCurrentListings(data) {
        if (!data || typeof data !== 'object') {
            logger.warn('getCurrentListings called with invalid data');
            return [];
        }

        if (!data.listings || !Array.isArray(data.listings)) {
            logger.info('No current listings available');
            return [];
        }

        try {
            const listings = data.listings
                .filter(listing => listing && typeof listing === 'object')
                .map(listing => ({
                    price: listing.pricePerUnit || 0,
                    quantity: listing.quantity || 0,
                    hq: listing.hq || false,
                    retainerName: listing.retainerName || 'Unknown',
                    worldName: listing.worldName || data.worldName || 'Unknown',
                }))
                .sort((a, b) => a.price - b.price); // Sort by price ascending

            logger.info('Current listings retrieved', { listingCount: listings.length });
            return listings;

        } catch (error) {
            logger.error('Error processing current listings', { 
                error: error.message 
            });
            return [];
        }
    }

    /**
     * Check if world name is valid
     * @param {string} worldName - World name to check
     * @returns {boolean} True if valid
     */
    isValidWorld(worldName) {
        if (!worldName || typeof worldName !== 'string') {
            return false;
        }

        // This is a basic check - you might want to maintain a list of valid worlds
        const normalized = worldName.trim();
        return normalized.length > 0 && /^[a-zA-Z\s-]+$/.test(normalized);
    }
}

module.exports = UniversalisService;
