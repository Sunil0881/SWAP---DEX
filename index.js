const express = require('express');
const { Web3 } = require('web3')
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Initialize Web3 with your provider
const web3 = new Web3(process.env.WEB3_PROVIDER_URL || 'https://sepolia.infura.io/v3/290819ba5ca344eea8990cb5ccaa8e6a');

// Cache for storing price data
const priceCache = new Map();
const CACHE_DURATION = 60 * 1000; // 1 minute cache

// Helper function to get token price from CoinGecko
async function getTokenPrice(tokenId) {
    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`
        );
        return response.data[tokenId].usd;
    } catch (error) {
        console.error(`Error fetching price for ${tokenId}:`, error);
        throw new Error('Failed to fetch token price');
    }
}

// Calculate swap amounts based on input
function calculateSwapAmount(inputAmount, inputPrice, outputPrice) {
    // Basic calculation (can be modified based on your specific requirements)
    const inputValueUSD = inputAmount * inputPrice;
    const outputAmount = inputValueUSD / outputPrice;
    
    // Apply a 0.3% fee (similar to Uniswap V2)
    const fee = outputAmount * 0.003;
    const finalAmount = outputAmount - fee;
    x
    return {
        outputAmount: finalAmount,
        fee,
        exchangeRate: inputPrice / outputPrice
    };
}

// Endpoint to get token prices
app.get('/api/prices/:tokenId', async (req, res) => {
    try {
        const { tokenId } = req.params;
        
        // Check cache first
        if (priceCache.has(tokenId)) {
            const { price, timestamp } = priceCache.get(tokenId);
            if (Date.now() - timestamp < CACHE_DURATION) {
                return res.json({ price });
            }
        }

        const price = await getTokenPrice(tokenId);
        priceCache.set(tokenId, { price, timestamp: Date.now() });
        
        res.json({ price });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to calculate swap
app.post('/api/calculate-swap', async (req, res) => {
    try {
        const { inputToken, outputToken, inputAmount } = req.body;
        
        if (!inputToken || !outputToken || !inputAmount) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        // Get prices for both tokens
        const inputPrice = await getTokenPrice(inputToken);
        const outputPrice = await getTokenPrice(outputToken);
        
        const swapDetails = calculateSwapAmount(inputAmount, inputPrice, outputPrice);
        
        res.json({
            inputToken,
            outputToken,
            inputAmount,
            inputPrice,
            outputPrice,
            ...swapDetails
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Price impact calculation endpoint
app.post('/api/price-impact', async (req, res) => {
    try {
        const { inputToken, outputToken, inputAmount } = req.body;
        
        // Calculate price impact (simplified version)
        const baseSwap = await calculateSwapAmount(1, inputPrice, outputPrice);
        const actualSwap = await calculateSwapAmount(inputAmount, inputPrice, outputPrice);
        
        const priceImpact = Math.abs((actualSwap.exchangeRate - baseSwap.exchangeRate) / baseSwap.exchangeRate * 100);
        
        res.json({ priceImpact });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Token swap backend running on port ${port}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});