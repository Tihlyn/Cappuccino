const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const logger = require('../utils/logger');

/**
 * Chart Generator Service
 * Generates price history charts for market analysis
 */
class ChartGenerator {
    constructor() {
        this.width = 800;
        this.height = 400;
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({ 
            width: this.width, 
            height: this.height,
            backgroundColour: '#1e1e1e'
        });
        
        logger.info('ChartGenerator initialized');
    }

    /**
     * Generate price history chart
     * @param {Array} priceHistory - Array of price history objects with timestamp and price
     * @param {Array} predictions - Array of predicted prices
     * @param {string} itemName - Name of the item
     * @returns {Promise<Buffer>} PNG image buffer
     */
    async generatePriceChart(priceHistory, predictions, itemName) {
        if (!priceHistory || !Array.isArray(priceHistory) || priceHistory.length === 0) {
            logger.warn('generatePriceChart: No price history provided');
            throw new Error('No price history available for chart generation');
        }

        try {
            logger.debug('Generating price chart', { 
                historyLength: priceHistory.length,
                predictionsLength: predictions?.length || 0,
                itemName 
            });

            // Prepare historical data - limit to last 50 entries for readability
            const limitedHistory = priceHistory.slice(-50);
            const historicalLabels = limitedHistory.map((entry, index) => {
                const date = new Date(entry.timestamp * 1000);
                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
            const historicalPrices = limitedHistory.map(entry => entry.price);

            // Prepare prediction data
            let predictionLabels = [];
            let predictionPrices = [];
            
            if (predictions && predictions.length > 0) {
                predictionLabels = predictions.map((_, index) => `Day +${index + 1}`);
                predictionPrices = predictions;
            }

            // Combine labels
            const allLabels = [...historicalLabels, ...predictionLabels];
            
            // Create datasets
            const datasets = [
                {
                    label: 'Historical Prices',
                    data: [...historicalPrices, ...Array(predictionLabels.length).fill(null)],
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    tension: 0.1,
                    fill: false
                }
            ];

            // Add predictions dataset if available
            if (predictionPrices.length > 0) {
                datasets.push({
                    label: 'Predictions',
                    data: [...Array(historicalLabels.length).fill(null), ...predictionPrices],
                    borderColor: 'rgb(255, 159, 64)',
                    backgroundColor: 'rgba(255, 159, 64, 0.2)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    tension: 0.1,
                    fill: false
                });
            }

            const configuration = {
                type: 'line',
                data: {
                    labels: allLabels,
                    datasets: datasets
                },
                options: {
                    responsive: false,
                    plugins: {
                        title: {
                            display: true,
                            text: `Price History - ${itemName}`,
                            color: '#ffffff',
                            font: {
                                size: 18,
                                weight: 'bold'
                            }
                        },
                        legend: {
                            display: true,
                            position: 'top',
                            labels: {
                                color: '#ffffff',
                                font: {
                                    size: 12
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            display: true,
                            title: {
                                display: true,
                                text: 'Date',
                                color: '#ffffff',
                                font: {
                                    size: 14
                                }
                            },
                            ticks: {
                                color: '#cccccc',
                                maxRotation: 45,
                                minRotation: 45,
                                autoSkip: true,
                                maxTicksLimit: 15
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        },
                        y: {
                            display: true,
                            title: {
                                display: true,
                                text: 'Price (gil)',
                                color: '#ffffff',
                                font: {
                                    size: 14
                                }
                            },
                            ticks: {
                                color: '#cccccc',
                                callback: function(value) {
                                    return value.toLocaleString() + ' gil';
                                }
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        }
                    }
                }
            };

            const imageBuffer = await this.chartJSNodeCanvas.renderToBuffer(configuration);
            
            logger.info('Price chart generated successfully', { 
                itemName,
                bufferSize: imageBuffer.length 
            });

            return imageBuffer;

        } catch (error) {
            logger.error('Error generating price chart', { 
                error: error.message,
                stack: error.stack,
                itemName 
            });
            throw new Error(`Failed to generate price chart: ${error.message}`);
        }
    }
}

module.exports = ChartGenerator;
