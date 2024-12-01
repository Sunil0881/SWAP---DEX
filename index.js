const express = require('express');
const { Web3 } = require('web3');
const axios = require('axios');
require('dotenv').config();

// Add required ABIs
const ROUTER_ABI = require('./abi/uniswap.json');
const ERC20_ABI = require('./abi/erc20.json');

const app = express();
app.use(express.json());

// Initialize Web3 with your Infura provider
const web3 = new Web3(process.env.WEB3_PROVIDER_URL || 'https://sepolia.infura.io/v3/290819ba5ca344eea8990cb5ccaa8e6a');

// Contract addresses (Sepolia testnet - you'll need to replace these with actual Sepolia addresses)
// Contract addresses (Sepolia testnet)
const UNISWAP_ROUTER_ADDRESS = '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008'; // Sepolia Uniswap V2 Router
const WETH_ADDRESS = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9'; // Sepolia WETH

// Initialize contract instances
const routerContract = new web3.eth.Contract(ROUTER_ABI, UNISWAP_ROUTER_ADDRESS);

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
    const inputValueUSD = inputAmount * inputPrice;
    const outputAmount = inputValueUSD / outputPrice;
    
    // Apply a 0.3% fee (similar to Uniswap V2)
    const fee = outputAmount * 0.003;
    const finalAmount = outputAmount - fee;
    
    return {
        outputAmount: finalAmount,
        fee,
        exchangeRate: inputPrice / outputPrice
    };
}

// Token approval function
async function approveToken(tokenAddress, amount, walletAddress, privateKey) {
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
    
    const approvalTx = tokenContract.methods.approve(
        UNISWAP_ROUTER_ADDRESS,
        web3.utils.toWei(amount.toString())
    );

    const gas = await approvalTx.estimateGas({ from: walletAddress });
    const gasPrice = await web3.eth.getGasPrice();
    const nonce = await web3.eth.getTransactionCount(walletAddress);

    const signedTx = await web3.eth.accounts.signTransaction(
        {
            to: tokenAddress,
            data: approvalTx.encodeABI(),
            gas,
            gasPrice,
            nonce,
        },
        privateKey
    );

    return web3.eth.sendSignedTransaction(signedTx.rawTransaction);
}

// Perform swap function
async function performSwap(
    inputTokenAddress,
    outputTokenAddress,
    amount,
    walletAddress,
    privateKey,
    slippageTolerance = 0.5
) {
    try {
        const amountIn = web3.utils.toWei(amount.toString());
        const path = [inputTokenAddress, WETH_ADDRESS, outputTokenAddress];
        
        const amountsOut = await routerContract.methods.getAmountsOut(amountIn, path).call();
        const minimumAmountOut = web3.utils.toBN(amountsOut[amountsOut.length - 1])
            .mul(web3.utils.toBN(1000 - (slippageTolerance * 10)))
            .div(web3.utils.toBN(1000));

        const deadline = Math.floor(Date.now() / 1000) + 1200;

        const swapTx = routerContract.methods.swapExactTokensForTokens(
            amountIn,
            minimumAmountOut,
            path,
            walletAddress,
            deadline
        );

        const gas = await swapTx.estimateGas({ from: walletAddress });
        const gasPrice = await web3.eth.getGasPrice();
        const nonce = await web3.eth.getTransactionCount(walletAddress);

        const signedTx = await web3.eth.accounts.signTransaction(
            {
                to: UNISWAP_ROUTER_ADDRESS,
                data: swapTx.encodeABI(),
                gas,
                gasPrice,
                nonce,
            },
            privateKey
        );

        return web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } catch (error) {
        console.error('Swap error:', error);
        throw error;
    }
}

// Original endpoints
app.get('/api/prices/:tokenId', async (req, res) => {
    try {
        const { tokenId } = req.params;
        
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

app.post('/api/calculate-swap', async (req, res) => {
    try {
        const { inputToken, outputToken, inputAmount } = req.body;
        
        if (!inputToken || !outputToken || !inputAmount) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
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

app.post('/api/price-impact', async (req, res) => {
    try {
        const { inputToken, outputToken, inputAmount } = req.body;
        
        const inputPrice = await getTokenPrice(inputToken);
        const outputPrice = await getTokenPrice(outputToken);
        
        const baseSwap = calculateSwapAmount(1, inputPrice, outputPrice);
        const actualSwap = calculateSwapAmount(inputAmount, inputPrice, outputPrice);
        
        const priceImpact = Math.abs((actualSwap.exchangeRate - baseSwap.exchangeRate) / baseSwap.exchangeRate * 100);
        
        res.json({ priceImpact });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// New swap endpoint
app.post('/api/swap', async (req, res) => {
    try {
        const {
            inputTokenAddress,
            outputTokenAddress,
            amount,
            walletAddress,
            privateKey,
            slippageTolerance
        } = req.body;

        if (!inputTokenAddress || !outputTokenAddress || !amount || !walletAddress || !privateKey) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const approvalTx = await approveToken(
            inputTokenAddress,
            amount,
            walletAddress,
            privateKey
        );

        const swapTx = await performSwap(
            inputTokenAddress,
            outputTokenAddress,
            amount,
            walletAddress,
            privateKey,
            slippageTolerance
        );

        res.json({
            success: true,
            approvalTxHash: approvalTx.transactionHash,
            swapTxHash: swapTx.transactionHash,
            gasUsed: swapTx.gasUsed
        });

    } catch (error) {
        console.error('Error in swap route:', error);
        res.status(500).json({
            error: 'Swap failed',
            details: error.message
        });
    }
});

// Get token allowance endpoint
app.get('/api/allowance/:tokenAddress/:walletAddress', async (req, res) => {
    try {
        const { tokenAddress, walletAddress } = req.params;
        const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
        
        const allowance = await tokenContract.methods
            .allowance(walletAddress, UNISWAP_ROUTER_ADDRESS)
            .call();

        res.json({
            tokenAddress,
            walletAddress,
            allowance: web3.utils.fromWei(allowance)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Token swap backend running on port ${port}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});