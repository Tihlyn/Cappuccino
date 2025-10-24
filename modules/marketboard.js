const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const XIVAPIService = require('../services/xivapi');
const UniversalisService = require('../services/universalis');
const MarketAnalyzer = require('../services/market-analyzer');
const ChartGenerator = require('../services/chart-generator');
const logger = require('../utils/logger');

/**
 * Marketboard Module - Main module for market analysis functionality
 * Integrates XIVAPI for item search and Universalis for market data
 */
class MarketboardModule {
    constructor() {
        this.xivapiService = new XIVAPIService();
        this.universalisService = new UniversalisService();
        this.marketAnalyzer = new MarketAnalyzer(this.universalisService);
        this.chartGenerator = new ChartGenerator();
        
        // Autocomplete is disabled
        logger.info('MarketboardModule initialized (autocomplete disabled)');
    }

    /**
     * Get slash command definitions
     * @returns {Array} Array of SlashCommandBuilder objects
     */
    getCommands() {
        return [
            new SlashCommandBuilder()
                .setName('market')
                .setDescription('Analyze FFXIV market prices and get predictions')
                .addStringOption(option =>
                    option.setName('item')
                        .setDescription('Item name to search (supports EN, FR, DE)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('world')
                        .setDescription('Server world (default: Sagittarius)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('language')
                        .setDescription('Item language (default: English)')
                        .addChoices(
                            { name: 'English', value: 'en' },
                            { name: 'Français', value: 'fr' },
                            { name: 'Deutsch', value: 'de' }
                        )
                        .setRequired(false)),
        ];
    }

    /**
     * Handle autocomplete interactions (disabled)
     */
    async handleAutocomplete(interaction) {
        try {
            logger.debug('Autocomplete interaction received but feature is disabled');
            await interaction.respond([]);
        } catch (_) {
            // no-op
        }
    }

    /**
     * Handle market command
     * @param {Interaction} interaction - Discord interaction
     */
    async handleCommand(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const itemInput = interaction.options.getString('item');
            const world = interaction.options.getString('world') || 'Sagittarius';
            const language = (interaction.options.getString('language') || 'en').toLowerCase();

            if (!itemInput) {
                logger.warn('Market command called without item');
                return await interaction.editReply({
                    content: '❌ Please provide an item name to search.',
                });
            }

            logger.info('Processing market command', { itemInput, world, language });

            // Resolve item: try exact match, then best fuzzy match from XIVAPI
            let itemId;
            let itemName;

            // If the user pasted an explicit id:name, still support it
            if (itemInput.includes(':')) {
                const parts = itemInput.split(':', 2);
                itemId = parseInt(parts[0], 10);
                itemName = parts[1];
            }

            if (!itemId || isNaN(itemId) || itemId <= 0) {
                // Exact match first (language-aware)
                const exactMatch = await this.xivapiService.findExactMatch(itemInput, language);

                if (exactMatch) {
                    itemId = exactMatch.id;
                    itemName = exactMatch.name;
                } else {
                    // Best fuzzy match (top result) - language-aware
                    const searchResults = await this.xivapiService.searchItems(itemInput, 5, language);

                    if (!searchResults || searchResults.length === 0) {
                        logger.info('No items found for query', { itemInput });
                        return await interaction.editReply({
                            content: `❌ No items found matching "${itemInput}". Try a more specific name.`,
                        });
                    }

                    const best = searchResults[0];
                    itemId = best.id;
                    itemName = best.name;
                    logger.info('Using best fuzzy match', { itemId, itemName });
                }
            }

            // Validate item ID
            if (!itemId || isNaN(itemId) || itemId <= 0) {
                logger.warn('Invalid item ID resolved', { itemInput, itemId });
                return await interaction.editReply({
                    content: '❌ Could not resolve the item. Please try another name.',
                });
            }

            // Fetch canonical item name to ensure readability (language-aware)
            try {
                const itemDetails = await this.xivapiService.getItemById(itemId, language);
                if (itemDetails && itemDetails.name) {
                    itemName = itemDetails.name;
                }
            } catch (e) {
                logger.warn('Failed to fetch canonical item name, using resolved name', { error: e.message });
            }
            
            // Ensure we have a proper item name, prefer user input as readable fallback
            if (!itemName || itemName.trim().length === 0) {
                const cleaned = (itemInput || '').trim();
                if (cleaned) {
                    itemName = cleaned.replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                } else {
                    itemName = `Item #${itemId}`;
                }
                logger.warn('Using fallback item name', { itemId, itemName });
            }

            // Validate world name
            if (!this.universalisService.isValidWorld(world)) {
                logger.warn('Invalid world name provided', { world });
                return await interaction.editReply({
                    content: `❌ Invalid world name: "${world}". Please provide a valid server world.`,
                });
            }

            logger.info('Analyzing market', { itemId, itemName, world });

            // Analyze market
            const analysis = await this.marketAnalyzer.analyzeItem(itemId, itemName, world);

            // Create embed
            const embed = this.createMarketEmbed(analysis);
            
            // Generate price chart
            let files = [];
            try {
                if (analysis.priceHistory && analysis.priceHistory.length > 0) {
                    const chartBuffer = await this.chartGenerator.generatePriceChart(
                        analysis.priceHistory,
                        analysis.predictions,
                        analysis.itemName
                    );
                    const attachment = new AttachmentBuilder(chartBuffer, { name: 'price-chart.png' });
                    files.push(attachment);
                    
                    // Add image to embed
                    embed.setImage('attachment://price-chart.png');
                    
                    logger.info('Price chart generated and attached', { itemId, itemName });
                }
            } catch (chartError) {
                logger.warn('Failed to generate price chart, continuing without it', { 
                    error: chartError.message 
                });
                // Continue without the chart - non-critical feature
            }

            // Send embed with chart
            await interaction.editReply({ embeds: [embed], files });

            logger.info('Market analysis sent', { itemId, itemName, world });

        } catch (error) {
            logger.error('Error handling market command', { 
                error: error.message,
                stack: error.stack 
            });

            const errorMessage = error.message.includes('Insufficient price history')
                ? `❌ **Error:** ${error.message}\n\nThis item may not have enough market activity for predictions.`
                : `❌ **Error:** ${error.message}\n\nPlease try again or contact an administrator if the problem persists.`;

            await interaction.editReply({ content: errorMessage }).catch(() => {});
        }
    }

    /**
     * Create market analysis embed
     * @param {Object} analysis - Analysis results
     * @returns {EmbedBuilder} Discord embed
     */
    createMarketEmbed(analysis) {
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle(`📈 Market Analysis: ${analysis.itemName}`)
            .setDescription(`Server: **${analysis.world}** | Method: ${analysis.predictionMethod}`)
            .addFields(
                {
                    name: '💰 Current Average Price',
                    value: `${analysis.currentPrice?.toLocaleString() || 'N/A'} gil`,
                    inline: true
                },
                {
                    name: '📊 Recent Average (5 entries)',
                    value: `${Math.round(analysis.avgRecentPrice).toLocaleString()} gil`,
                    inline: true
                },
                {
                    name: '📈 Trend',
                    value: analysis.trend,
                    inline: true
                }
            );

        // Add current cheapest listings if available
        if (analysis.currentListings && analysis.currentListings.length > 0) {
            const listingsText = analysis.currentListings
                .slice(0, 5) // Show top 5
                .map(listing => 
                    `${listing.price.toLocaleString()} gil × ${listing.quantity}${listing.hq ? ' (HQ)' : ''}`
                )
                .join('\n');
            
            embed.addFields({
                name: '🛒 Current Cheapest Listings',
                value: listingsText,
                inline: false
            });
        }

        // Add predictions - format 4 days per line
        if (analysis.predictions && analysis.predictions.length > 0) {
            const predictionLines = [];
            for (let i = 0; i < analysis.predictions.length; i += 4) {
                const chunk = analysis.predictions.slice(i, i + 4);
                const line = chunk
                    .map((price, idx) => `D${i + idx + 1}: ${Math.round(price).toLocaleString()}`)
                    .join(' | ');
                predictionLines.push(line);
            }
            const predictionsText = predictionLines.join('\n');
            
            embed.addFields({
                name: '🔮 7-Day Price Predictions',
                value: predictionsText,
                inline: false
            });
        } else {
            embed.addFields({
                name: '🔮 7-Day Price Predictions',
                value: 'Predictions unavailable',
                inline: false
            });
        }

        // Add analysis info
        embed.addFields({
            name: '📋 Analysis Info',
            value: `Data Points: ${analysis.dataPoints}\nLast Updated: ${analysis.lastUpdated}`,
            inline: false
        });

        embed.setFooter({
            text: 'Predictions are estimates based on historical data. Market conditions can change rapidly.'
        });

        embed.setTimestamp();

        return embed;
    }

    /**
     * Clear caches
     */
    clearCaches() {
        // Keep for API services
        this.xivapiService.clearCache();
        logger.info('Caches cleared');
    }
}

module.exports = MarketboardModule;
