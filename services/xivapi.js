const axios = require('axios');
const Fuse = require('fuse.js');
const logger = require('../utils/logger');

// Helper to normalize strings for comparison (remove accents/punctuation, lowercase)
function normalizeStr(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // diacritics
        .replace(/[\u2018\u2019\u201C\u201D]/g, '"') // curly quotes to straight
        .replace(/[`'’]/g, "'")
        .replace(/[^\p{L}\p{N}\s'-]/gu, '') // remove most punctuation except hyphen/apostrophe
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// Helper to pick a name from fields based on requested language
function pickNameFromFields(fields, lang = 'en') {
    const name = fields?.Name || '';
    const en = fields?.Name_en || '';
    const fr = fields?.Name_fr || '';
    const de = fields?.Name_de || '';
    switch ((lang || 'en').toLowerCase()) {
        case 'fr':
            return fr || name || en || de || '';
        case 'de':
            return de || name || en || fr || '';
        case 'en':
        default:
            return en || name || fr || de || '';
    }
}

/**
 * XIVAPI Service for searching and retrieving FFXIV item data
 * Supports multilingual search (EN, FR, DE)
 * Uses XIVAPI V2 live endpoints
 */
class XIVAPIService {
    constructor() {
        this.baseURL = 'https://v2.xivapi.com/api/';
        this.cache = new Map();
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
        
        // Fuse.js configuration for fuzzy matching
        this.fuseOptions = {
            keys: ['Name', 'Name_en', 'Name_de', 'Name_fr'],
            threshold: 0.3, // Lower = more strict matching
            ignoreLocation: true,
            minMatchCharLength: 6, // Increased to reduce premature fuzzy hits
        };
        
        // Axios instance with default configuration
        this.axiosInstance = axios.create({
            baseURL: this.baseURL,
            timeout: 10000,
            headers: {
                'User-Agent': 'Serenity-Discord-Bot/1.0'
            }
        });
        
        logger.info('XIVAPIService initialized with V2 endpoints');
    }

    /**
     * Search for items by name with fuzzy matching, language-aware
     * @param {string} query - Search query
     * @param {number} limit - Maximum results to return
     * @param {string} language - 'en' | 'fr' | 'de' (default 'en')
     * @returns {Promise<Array>} Array of matching items
     */
    async searchItems(query, limit = 10, language = 'en') {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            logger.warn('searchItems called with invalid query', { query });
            return [];
        }

        const normalizedQuery = query.trim();
        logger.info('Searching for items', { query: normalizedQuery, limit });

        try {
            const fields = 'row_id,fields.Name,fields.Name_en,fields.Name_de,fields.Name_fr,fields.Icon,fields.ItemSearchCategory.fields.Name';

            // Escape special characters for XIVAPI search syntax
            const escapedQuery = normalizedQuery
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"');

            const config = {
                params: {
                    sheets: 'Item',
                    query: `Name~"${escapedQuery}"`,
                    fields,
                    limit: Math.min(limit, 100),
                    language: (language || 'en').toLowerCase()
                },
                headers: {
                    'Accept-Language': (language || 'en').toLowerCase(),
                    'User-Agent': 'Serenity-Discord-Bot/1.0'
                }
            };

            const resp = await this.axiosInstance.get('/search', config);
            const results = (resp.data && Array.isArray(resp.data.results)) ? resp.data.results : [];

            if (!results || results.length === 0) {
                logger.info('No items found for query', { query: normalizedQuery });
                return [];
            }

            // Prefer marketable items if available
            const marketableItems = results.filter(item => {
                const categoryName = item.fields?.ItemSearchCategory?.fields?.Name;
                return categoryName && categoryName !== '';
            });
            const base = marketableItems.length > 0 ? marketableItems : results;

            logger.info('Items found', { 
                query: normalizedQuery, 
                total: results.length,
                marketable: marketableItems.length 
            });

            // Convert to normalized format for fuzzy/regex matching
            const normalizedItems = base.map(item => ({
                row_id: item.row_id,
                Name: item.fields?.Name || item.fields?.Name_en || item.fields?.Name_fr || item.fields?.Name_de || '',
                Name_en: item.fields?.Name_en || '',
                Name_de: item.fields?.Name_de || '',
                Name_fr: item.fields?.Name_fr || '',
                Icon: item.fields?.Icon || '',
                ItemSearchCategory: {
                    Name: item.fields?.ItemSearchCategory?.fields?.Name || 'Unknown'
                }
            }));

            // Optional: regex support
            let filteredForRanking = normalizedItems;
            const regexMatch = normalizedQuery.match(/^\/(.+)\/([i]?)$/);
            if (regexMatch) {
                try {
                    const pattern = regexMatch[1];
                    const flags = regexMatch[2] || '';
                    const rx = new RegExp(pattern, flags);
                    const rxFilter = (n) => rx.test(n || '');
                    const rxFiltered = normalizedItems.filter(it => (
                        rxFilter(it.Name) || rxFilter(it.Name_en) || rxFilter(it.Name_de) || rxFilter(it.Name_fr)
                    ));
                    if (rxFiltered.length > 0) {
                        filteredForRanking = rxFiltered;
                        logger.debug('Applied regex filter to search results', { count: rxFiltered.length });
                    }
                } catch (e) {
                    logger.warn('Invalid regex pattern provided, ignoring', { error: e.message });
                }
            }

            // Fuzzy ranking
            const fuse = new Fuse(filteredForRanking, this.fuseOptions);
            const fuzzyResults = fuse.search(normalizedQuery);

            const sortedResults = fuzzyResults.length > 0 
                ? fuzzyResults.map(result => result.item).slice(0, limit)
                : filteredForRanking.slice(0, limit);

            return sortedResults.map(item => ({
                id: item.row_id,
                name: pickNameFromFields({
                    Name: item.Name,
                    Name_en: item.Name_en,
                    Name_fr: item.Name_fr,
                    Name_de: item.Name_de
                }, language),
                nameEn: item.Name_en,
                nameDe: item.Name_de,
                nameFr: item.Name_fr,
                icon: item.Icon,
                category: item.ItemSearchCategory?.Name || 'Unknown',
            }));

        } catch (error) {
            logger.error('Error searching items', { 
                query: normalizedQuery, 
                error: error.message,
                stack: error.stack 
            });
            throw new Error(`Failed to search items: ${error.message}`);
        }
    }

    /**
     * Get item by ID with caching (language-aware)
     * @param {number} itemId - Item ID
     * @param {string} language - 'en' | 'fr' | 'de' (default 'en')
     * @returns {Promise<Object|null>} Item data or null if not found
     */
    async getItemById(itemId, language = 'en') {
        if (!itemId || !Number.isInteger(itemId) || itemId <= 0) {
            logger.warn('getItemById called with invalid itemId', { itemId });
            return null;
        }

        logger.info('Getting item by ID', { itemId });

        // Check cache first (language-agnostic cache for simplicity)
        const cached = this.cache.get(itemId);
        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            logger.debug('Returning cached item', { itemId });
            return cached.data;
        }

        try {
            const fields = 'row_id,fields.Name,fields.Name_en,fields.Name_de,fields.Name_fr,fields.Icon,fields.ItemSearchCategory.fields.Name,fields.Description';
            
            const response = await this.axiosInstance.get(`/sheet/Item/${itemId}`, {
                params: {
                    fields,
                    language: (language || 'en').toLowerCase()
                },
                headers: {
                    'Accept-Language': (language || 'en').toLowerCase(),
                    'User-Agent': 'Serenity-Discord-Bot/1.0'
                }
            });

            if (!response.data || !response.data.row_id) {
                logger.warn('Item not found', { itemId });
                return null;
            }

            const result = response.data;
            const itemData = {
                id: result.row_id,
                name: pickNameFromFields(result.fields, language) || '',
                nameEn: result.fields?.Name_en || '',
                nameDe: result.fields?.Name_de || '',
                nameFr: result.fields?.Name_fr || '',
                icon: result.fields?.Icon || '',
                category: result.fields?.ItemSearchCategory?.fields?.Name || 'Unknown',
                description: result.fields?.Description || '',
            };

            // Cache the result
            this.cache.set(itemId, {
                data: itemData,
                timestamp: Date.now(),
            });

            logger.info('Item retrieved and cached', { itemId, name: itemData.name });
            return itemData;

        } catch (error) {
            logger.error('Error getting item by ID', { 
                itemId, 
                error: error.message,
                stack: error.stack 
            });
            throw new Error(`Failed to get item: ${error.message}`);
        }
    }

    /**
     * Search for exact item match (language-aware)
     * @param {string} itemName - Exact item name
     * @param {string} language - 'en' | 'fr' | 'de'
     * @returns {Promise<Object|null>} Exact match or null
     */
    async findExactMatch(itemName, language = 'en') {
        if (!itemName || typeof itemName !== 'string') {
            return null;
        }

        const normalizedName = normalizeStr(itemName);
        logger.info('Finding exact match', { itemName: normalizedName });

        try {
            const results = await this.searchItems(itemName, 50, language);
            
            // Try to find exact match across localized fields (normalized)
            const exactMatch = results.find(item => {
                const names = [item.name, item.nameEn, item.nameDe, item.nameFr].filter(Boolean);
                return names.some(n => normalizeStr(n) === normalizedName);
            });

            if (exactMatch) {
                logger.info('Exact match found', { 
                    itemName: normalizedName, 
                    matchedId: exactMatch.id 
                });
            } else {
                logger.info('No exact match found', { itemName: normalizedName });
            }

            return exactMatch || null;

        } catch (error) {
            logger.error('Error finding exact match', { 
                itemName: normalizedName, 
                error: error.message 
            });
            return null;
        }
    }

    /**
     * Clear cache
     */
    clearCache() {
        const size = this.cache.size;
        this.cache.clear();
        logger.info('Cache cleared', { itemsCleared: size });
    }
}

module.exports = XIVAPIService;
