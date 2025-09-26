const express = require('express');
const axios = require('axios');
const cors = require('cors');
const yf = require('yahoo-finance2').default;

const app = express();

app.use(cors());
app.use(express.json());

const YF_BASE = 'https://query1.finance.yahoo.com';
const DEFAULT_AXIOS = axios.create({
  baseURL: YF_BASE,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*',
  },
  timeout: 15000,
});

function toUpperNoSpaces(input) {
  return String(input || '').toUpperCase().trim();
}

// Black-Scholes probability calculations
function normalCDF(x) {
  // Approximation of cumulative normal distribution
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x) / Math.sqrt(2);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function calculateDelta(currentPrice, strikePrice, timeToExpiry, riskFreeRate, volatility, optionType = 'call') {
  if (timeToExpiry <= 0) return optionType === 'call' ? (currentPrice > strikePrice ? 1 : 0) : (currentPrice < strikePrice ? -1 : 0);
  
  const S = currentPrice;
  const K = strikePrice;
  const T = timeToExpiry;
  const r = riskFreeRate;
  const sigma = volatility;
  
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  
  if (optionType === 'call') {
    return normalCDF(d1);
  } else {
    return normalCDF(d1) - 1;
  }
}

function calculateAssignmentProbability(currentPrice, strikePrice, timeToExpiry, riskFreeRate, volatility, marketDelta = null) {
  if (timeToExpiry <= 0) return { 
    original: strikePrice <= currentPrice ? 1 : 0,
    enhanced: strikePrice <= currentPrice ? 1 : 0
  };
  
  const S = currentPrice;
  const K = strikePrice;
  const T = timeToExpiry;
  const r = riskFreeRate;
  const sigma = volatility;
  
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  
  // Original Black-Scholes probability
  const originalProb = normalCDF(d2);
  
  // Enhanced probability with market corrections
  let enhancedProb = originalProb;
  
  // 1. Delta-based probability adjustment (if market delta is available)
  if (marketDelta !== null && marketDelta !== undefined) {
    // For calls: delta approximates ITM probability
    const deltaProb = Math.abs(marketDelta);
    // Weighted combination: 70% BS, 30% market delta
    enhancedProb = (originalProb * 0.7) + (deltaProb * 0.3);
  }
  
  // 2. Implied volatility adjustment
  const defaultVol = 0.25; // 25% baseline volatility
  const volAdjustment = Math.min(2.0, Math.max(0.5, sigma / defaultVol)); // Cap between 0.5x and 2x
  enhancedProb = enhancedProb * volAdjustment;
  
  // 3. Time decay acceleration for very short-term options
  if (T < (7/365)) { // Less than 1 week
    const timeAcceleration = 1 + (0.1 * (7/365 - T) / (7/365)); // Up to 10% increase
    enhancedProb = enhancedProb * timeAcceleration;
  }
  
  // 4. Moneyness adjustment
  const moneyness = S / K;
  if (moneyness > 1.05) { // More than 5% ITM
    enhancedProb = enhancedProb * 1.1; // Increase probability
  } else if (moneyness > 0.95 && moneyness <= 1.05) { // Near the money
    enhancedProb = enhancedProb * 1.05; // Slight increase
  }
  
  // Ensure probability stays between 0 and 1
  enhancedProb = Math.max(0, Math.min(1, enhancedProb));
  
  return {
    original: originalProb,
    enhanced: enhancedProb
  };
}

function calculateGoalBasedScore(premium, assignmentProbability, strike, currentPrice, daysToExpiry) {
  // Target: 0.1% weekly return or 0.2% bi-weekly return
  const weeklyTarget = 0.001; // 0.1%
  const biweeklyTarget = 0.002; // 0.2%
  
  // Calculate return as percentage of stock price (for cash-secured puts or covered calls)
  const returnPercent = premium / currentPrice;
  
  // Calculate annualized return
  const annualizedReturn = (returnPercent * 365) / daysToExpiry;
  
  // Check if meets minimum return targets
  let meetsTarget = false;
  let targetType = '';
  
  if (daysToExpiry <= 8) { // Weekly expiration
    if (returnPercent >= weeklyTarget) {
      meetsTarget = true;
      targetType = 'weekly';
    }
  } else if (daysToExpiry <= 16) { // Bi-weekly expiration  
    if (returnPercent >= biweeklyTarget) {
      meetsTarget = true;
      targetType = 'bi-weekly';
    }
  }
  
  if (!meetsTarget) return -1; // Doesn't meet minimum return requirement
  
  // Score = (Premium return / Assignment probability) with bonuses
  const baseScore = returnPercent / (assignmentProbability / 100 + 0.001); // Add small value to avoid division by zero
  
  // Bonus for good volume/liquidity (will be added later)
  // Penalty for very high assignment probability (>30%)
  const highProbabilityPenalty = assignmentProbability > 30 ? 0.5 : 1;
  
  return baseScore * highProbabilityPenalty;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: 'neural-network' });
});

// Get real-time quote for a symbol (Stooq for resilience)
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = toUpperNoSpaces(req.params.symbol);
  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }
  try {
    // Stooq prefers country suffix (US equities as .US)
    const stooqSymbol = /\.\w+$/.test(symbol) ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&e=csv`;
    const { data: csv } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/csv, text/plain, */*',
      },
      responseType: 'text',
    });
    // Stooq lightweight CSV usually returns a single data row without headers
    const lines = String(csv).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return res.status(404).json({ error: 'Quote not found' });
    let record;
    if (lines.length >= 2 && /Symbol/i.test(lines[0])) {
      const headers = lines[0].split(',');
      const values = lines[1].split(',');
      record = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    } else {
      // fields order per f=sd2t2ohlcv → Symbol,Date,Time,Open,High,Low,Close,Volume
      const values = lines[lines.length - 1].split(',');
      const headers = ['Symbol','Date','Time','Open','High','Low','Close','Volume'];
      record = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    }
    const closeStr = record.Close;
    const price = Number(closeStr);
    if (!Number.isFinite(price)) return res.status(404).json({ error: 'Invalid price' });
    res.json({
      symbol: symbol,
      shortName: symbol,
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketPrice: price,
      regularMarketChange: null,
      regularMarketChangePercent: null,
      regularMarketTime: Math.floor(new Date(`${record.Date}T${record.Time || '00:00:00'}Z`).getTime()/1000) || Math.floor(Date.now()/1000),
      exchange: 'STOOQ',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote', details: err?.message });
  }
});

// Get call options for current and next 4 weeks (any OTM up to 10%)
app.get('/api/options-weeks/:symbol', async (req, res) => {
  const symbol = toUpperNoSpaces(req.params.symbol);
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  try {
    // Get current stock price first
    const quote = await yf.quoteSummary(symbol, { modules: ['price'] });
    const currentPrice = quote?.price?.regularMarketPrice;
    if (!currentPrice || !Number.isFinite(currentPrice)) {
      return res.status(400).json({ error: 'Unable to get current stock price' });
    }

    const base = await yf.options(symbol);
    const expirations = base?.expirationDates || [];
    if (!expirations.length) return res.status(404).json({ error: 'No expirations available' });

    // Sort all expirations chronologically
    const sortedExpirations = expirations.sort((a, b) => a.getTime() - b.getTime());
    
    // Get current date (start of today)  
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Find the next 4 unique future expiration dates (including today if options expire today)
    const targets = [];
    const futureExpirations = sortedExpirations.filter(exp => exp.getTime() >= today.getTime());
    
    // Take the first 4 future expirations
    for (let i = 0; i < Math.min(4, futureExpirations.length); i++) {
      targets.push(futureExpirations[i]);
    }
    
    // Fallback: if no future expirations, take the latest available ones
    if (targets.length === 0 && sortedExpirations.length > 0) {
      targets.push(sortedExpirations[sortedExpirations.length - 1]);
    }

    // Calculate OTM range (any OTM up to 10% above current price)
    const otmLow = currentPrice * 1.001;  // Just above current price (any OTM)
    const otmHigh = currentPrice * 1.10;  // 10% OTM

    const results = [];
    for (const target of targets) {
      // Try to get full options chain
      const chain = await yf.options(symbol, { date: target });
      
      // Debug logging removed for production
      
      const opt = chain?.options?.[0];
      if (!opt) continue;
      
      const mapOption = (o) => {
        const timeToExpiry = (target.getTime() - Date.now()) / (1000 * 3600 * 24 * 365); // Years
        const daysToExpiry = (target.getTime() - Date.now()) / (1000 * 3600 * 24); // Days
        const riskFreeRate = 0.045; // Approximate current 10-year treasury rate
        const volatility = o.impliedVolatility || 0.25; // Use option's IV or default to 25%
        
        // Calculate theoretical delta for market comparison
        const theoreticalDelta = calculateDelta(currentPrice, o.strike, timeToExpiry, riskFreeRate, volatility, 'call');
        
        // Get assignment probabilities (both original and enhanced)
        const assignmentProbs = calculateAssignmentProbability(
          currentPrice, 
          o.strike, 
          timeToExpiry, 
          riskFreeRate, 
          volatility,
          theoreticalDelta // Use calculated delta as market delta approximation
        );
        
        const premium = (o.bid && o.ask) ? (o.bid + o.ask) / 2 : (o.lastPrice || 0); // Midpoint or last price
        const returnPercent = premium > 0 ? ((premium / currentPrice) * 100).toFixed(3) : '0.000'; // Return as % of stock price
        
        // Use enhanced probability for goal scoring
        const goalScore = calculateGoalBasedScore(premium, assignmentProbs.enhanced * 100, o.strike, currentPrice, daysToExpiry);
        
        // Calculate return/assignment ratio for both methods
        const originalRatio = premium > 0 && assignmentProbs.original > 0 ? 
          (((premium / currentPrice) * 100) / (assignmentProbs.original * 100)).toFixed(3) : 'N/A';
        const enhancedRatio = premium > 0 && assignmentProbs.enhanced > 0 ? 
          (((premium / currentPrice) * 100) / (assignmentProbs.enhanced * 100)).toFixed(3) : 'N/A';
        
        // Weekly vs bi-weekly target check  
        const weeklyReturn = premium > 0 ? (premium / currentPrice) * 100 : 0;
        const meetsWeeklyTarget = daysToExpiry <= 8 && weeklyReturn >= 0.1;
        const meetsBiweeklyTarget = daysToExpiry <= 16 && weeklyReturn >= 0.2;
        const meetsTarget = meetsWeeklyTarget || meetsBiweeklyTarget;
        const targetType = meetsWeeklyTarget ? 'weekly' : (meetsBiweeklyTarget ? 'bi-weekly' : 'none');
        
        return {
          contractSymbol: o.contractSymbol,
          strike: o.strike,
          lastPrice: o.lastPrice,
          bid: o.bid,
          ask: o.ask,
          change: o.change,
          percentChange: o.percentChange,
          volume: o.volume,
          openInterest: o.openInterest,
          impliedVolatility: o.impliedVolatility,
          inTheMoney: o.inTheMoney,
          otmPercent: ((o.strike - currentPrice) / currentPrice * 100).toFixed(2),
          assignmentProbability: (assignmentProbs.original * 100).toFixed(1), // Original BS probability
          assignmentProbabilityEnhanced: (assignmentProbs.enhanced * 100).toFixed(1), // Enhanced probability
          delta: (theoreticalDelta * 100).toFixed(1), // Theoretical delta
          premium: premium.toFixed(2),
          returnPercent: returnPercent,
          goalScore: goalScore > 0 ? goalScore.toFixed(3) : enhancedRatio,
          returnAssignmentRatio: originalRatio, // Original ratio
          returnAssignmentRatioEnhanced: enhancedRatio, // Enhanced ratio
          meetsTarget: meetsTarget,
          targetType: targetType,
          daysToExpiry: Math.round(daysToExpiry)
        };
      };

      // Filter calls for any OTM up to 10%
      const allCalls = (opt.calls || [])
        .filter(call => call.strike >= otmLow && call.strike <= otmHigh)
        .map(mapOption);
      
      // Show ALL options within OTM range, but identify which meet targets
      const qualifyingCalls = allCalls
        .filter(call => call.meetsTarget)
        .sort((a, b) => parseFloat(b.goalScore) - parseFloat(a.goalScore));
      
      // Sort all calls by strike price
      const finalCalls = allCalls.sort((a, b) => a.strike - b.strike);

      const bestOption = qualifyingCalls[0] || null;
      let bestOptionReason = '';
      
      if (bestOption) {
        bestOptionReason = `Meets ${bestOption.targetType} target (${bestOption.returnPercent}% return) with ${bestOption.assignmentProbability}% assignment risk. ` +
                          `Score: ${bestOption.goalScore} (higher is better for return/risk ratio).`;
      }

      results.push({
        expiration: Math.floor((opt.expirationDate?.getTime?.() || target.getTime()) / 1000),
        calls: finalCalls,
        bestOption: bestOption,
        bestOptionReason: bestOptionReason,
        hasQualifyingOptions: qualifyingCalls.length > 0
      });
    }

    res.json({ symbol, currentPrice, otmRange: { low: otmLow, high: otmHigh }, expirations: results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch weekly options', details: err?.message });
  }
});

// Random Forest Analysis Implementation
const trainedModels = {};

class SimpleRandomForest {
  constructor(nTrees = 120, maxDepth = 10, minSamplesSplit = 5) {
    this.nTrees = nTrees;
    this.maxDepth = maxDepth;
    this.minSamplesSplit = minSamplesSplit;
    this.trees = [];
    this.issTrained = false;
  }

  // Simple decision tree node
  static createNode(samples, targets, depth, maxDepth, minSamplesSplit) {
    if (depth >= maxDepth || samples.length < minSamplesSplit) {
      return { prediction: targets.reduce((a, b) => a + b) / targets.length, isLeaf: true };
    }

    // Find best split (simplified - just try random features and thresholds)
    let bestScore = Infinity;
    let bestSplit = null;
    const nFeatures = samples[0].length;
    
    for (let trial = 0; trial < Math.min(10, nFeatures * 3); trial++) {
      const featureIdx = Math.floor(Math.random() * nFeatures);
      const values = samples.map(s => s[featureIdx]).sort((a, b) => a - b);
      const threshold = values[Math.floor(Math.random() * values.length)];
      
      const leftIndices = [];
      const rightIndices = [];
      
      for (let i = 0; i < samples.length; i++) {
        if (samples[i][featureIdx] <= threshold) {
          leftIndices.push(i);
        } else {
          rightIndices.push(i);
        }
      }
      
      if (leftIndices.length === 0 || rightIndices.length === 0) continue;
      
      const leftTargets = leftIndices.map(i => targets[i]);
      const rightTargets = rightIndices.map(i => targets[i]);
      const leftMean = leftTargets.reduce((a, b) => a + b) / leftTargets.length;
      const rightMean = rightTargets.reduce((a, b) => a + b) / rightTargets.length;
      
      const score = leftTargets.reduce((sum, t) => sum + (t - leftMean) ** 2, 0) + 
                   rightTargets.reduce((sum, t) => sum + (t - rightMean) ** 2, 0);
      
      if (score < bestScore) {
        bestScore = score;
        bestSplit = { featureIdx, threshold, leftIndices, rightIndices };
      }
    }
    
    if (!bestSplit) {
      return { prediction: targets.reduce((a, b) => a + b) / targets.length, isLeaf: true };
    }
    
    const leftSamples = bestSplit.leftIndices.map(i => samples[i]);
    const leftTargets = bestSplit.leftIndices.map(i => targets[i]);
    const rightSamples = bestSplit.rightIndices.map(i => samples[i]);
    const rightTargets = bestSplit.rightIndices.map(i => targets[i]);
    
    return {
      featureIdx: bestSplit.featureIdx,
      threshold: bestSplit.threshold,
      left: SimpleRandomForest.createNode(leftSamples, leftTargets, depth + 1, maxDepth, minSamplesSplit),
      right: SimpleRandomForest.createNode(rightSamples, rightTargets, depth + 1, maxDepth, minSamplesSplit),
      isLeaf: false
    };
  }

  train(features, targets) {
    for (let i = 0; i < this.nTrees; i++) {
      // Bootstrap sampling
      const bootstrapSize = Math.floor(features.length * 0.8);
      const bootstrapIndices = [];
      for (let j = 0; j < bootstrapSize; j++) {
        bootstrapIndices.push(Math.floor(Math.random() * features.length));
      }
      
      const bootstrapFeatures = bootstrapIndices.map(idx => features[idx]);
      const bootstrapTargets = bootstrapIndices.map(idx => targets[idx]);
      
      const tree = SimpleRandomForest.createNode(
        bootstrapFeatures, 
        bootstrapTargets, 
        0, 
        this.maxDepth, 
        this.minSamplesSplit
      );
      
      this.trees.push(tree);
    }
    this.isTrained = true;
  }

  static predictSingle(tree, sample) {
    if (tree.isLeaf) return tree.prediction;
    if (sample[tree.featureIdx] <= tree.threshold) {
      return SimpleRandomForest.predictSingle(tree.left, sample);
    } else {
      return SimpleRandomForest.predictSingle(tree.right, sample);
    }
  }

  predict(samples) {
    if (!this.isTrained) throw new Error('Model not trained');
    
    return samples.map(sample => {
      const predictions = this.trees.map(tree => 
        SimpleRandomForest.predictSingle(tree, sample)
      );
      return predictions.reduce((a, b) => a + b) / predictions.length;
    });
  }
}

// Generate training data for RF model
function generateTrainingData(symbol, historicalData) {
  const features = [];
  const targets = [];
  
  for (let i = 0; i < historicalData.length; i++) {
    const price = historicalData[i].close;
    
    for (const dte of [1, 3, 7, 14, 21]) {
      for (const otmFrac of [0.02, 0.05, 0.10, 0.15]) {
        const strike = price * (1 + otmFrac);
        
        // Calculate simple volatility (last 20 days if available)
        let vol = 0.25; // default
        if (i >= 20) {
          const returns = [];
          for (let j = Math.max(0, i - 19); j < i; j++) {
            returns.push(Math.log(historicalData[j + 1].close / historicalData[j].close));
          }
          const mean = returns.reduce((a, b) => a + b) / returns.length;
          const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
          vol = Math.sqrt(variance * 252); // Annualized volatility
        }
        
        const T = dte / 365.0;
        const r = 0.045;
        const delta = calculateDelta(price, strike, T, r, vol);
        const bsProb = calculateAssignmentProbability(price, strike, T, r, vol, delta).enhanced;
        
        // Add noise to create training target
        const noise = (Math.random() - 0.5) * 0.1;
        const target = Math.max(0, Math.min(1, bsProb + noise));
        
        features.push([
          price / strike, // moneyness
          dte, // days to expiry
          vol, // volatility
          delta, // delta
          otmFrac, // otm percent
          Math.random() * 2, // volume (randomized for training)
          bsProb // bs probability
        ]);
        
        targets.push(target);
      }
    }
  }
  
  return { features, targets };
}

// Pure JavaScript Neural Network - Vercel Compatible
const neuralNetworks = {}; // Cache for trained networks

class LightweightAssignmentPredictor {
  constructor() {
    // Enhanced network: 13 -> 16 -> 8 -> 1 (3 new historical features)
    this.weights1 = this.initializeWeights(13, 16);  // Input to hidden1
    this.weights2 = this.initializeWeights(16, 8);   // Hidden1 to hidden2  
    this.weights3 = this.initializeWeights(8, 1);    // Hidden2 to output
    this.bias1 = new Array(16).fill(0);
    this.bias2 = new Array(8).fill(0);
    this.bias3 = new Array(1).fill(0);
    this.isTrained = false;
    this.learningRate = 0.1;
  }

  // Initialize random weights
  initializeWeights(inputSize, outputSize) {
    const weights = [];
    for (let i = 0; i < inputSize; i++) {
      weights[i] = [];
      for (let j = 0; j < outputSize; j++) {
        weights[i][j] = (Math.random() - 0.5) * 2; // Random between -1 and 1
      }
    }
    return weights;
  }

  // Sigmoid activation function
  sigmoid(x) {
    return 1 / (1 + Math.exp(-Math.max(-250, Math.min(250, x)))); // Prevent overflow
  }

  // Sigmoid derivative
  sigmoidDerivative(x) {
    return x * (1 - x);
  }

  // Forward pass
  forward(inputs) {
    // Input to hidden1
    const hidden1 = new Array(16);
    for (let j = 0; j < 16; j++) {
      let sum = this.bias1[j];
      for (let i = 0; i < 13; i++) { // Updated to 13 features
        sum += inputs[i] * this.weights1[i][j];
      }
      hidden1[j] = this.sigmoid(sum);
    }

    // Hidden1 to hidden2
    const hidden2 = new Array(8);
    for (let j = 0; j < 8; j++) {
      let sum = this.bias2[j];
      for (let i = 0; i < 16; i++) {
        sum += hidden1[i] * this.weights2[i][j];
      }
      hidden2[j] = this.sigmoid(sum);
    }

    // Hidden2 to output
    const output = new Array(1);
    for (let j = 0; j < 1; j++) {
      let sum = this.bias3[j];
      for (let i = 0; i < 8; i++) {
        sum += hidden2[i] * this.weights3[i][j];
      }
      output[j] = this.sigmoid(sum);
    }

    return { hidden1, hidden2, output: output[0] };
  }

  // Enhanced feature extraction with historical patterns (anti-overfitting)
  extractFeatures(currentPrice, strike, timeToExpiry, daysToExpiry, iv, volume, bid, ask, openInterest, historicalData = null) {
    const moneyness = currentPrice / strike;
    const delta = calculateDelta(currentPrice, strike, timeToExpiry, 0.045, iv);
    const otmPercent = (strike - currentPrice) / currentPrice;
    
    // Core features (unchanged)
    const volumeRatio = (volume || 0) / 1_000_000;
    const ivRank = this.calculateIVPercentile(iv);
    const bidAskSpread = (bid && ask && bid > 0 && ask > 0) ? (ask - bid) / ((ask + bid) / 2) : 0.1;
    const liquidityScore = 1 / (1 + bidAskSpread);
    const marketSentiment = 0.5; // Default neutral
    const timeDecay = Math.pow(daysToExpiry / 365, 2);
    
    // Historical features (robust, anti-overfitting)
    let historicalVolatilityTrend = 0.5; // Default neutral
    let priceVelocity = 0.5; // Default neutral  
    let earningsProximity = 0; // Default no earnings risk
    
    if (historicalData && historicalData.length >= 90) {
      // 1. Multi-timeframe volatility context (prevents overfitting to recent moves)
      const recent30Vol = this.calculateHistoricalVol(historicalData.slice(-30));
      const recent60Vol = this.calculateHistoricalVol(historicalData.slice(-60));
      const recent90Vol = this.calculateHistoricalVol(historicalData.slice(-90));
      
      // Volatility trend: is volatility increasing or decreasing over time?
      const volTrend = (recent30Vol - recent90Vol) / recent90Vol;
      historicalVolatilityTrend = this.normalize(volTrend, -0.5, 0.5); // Normalized trend
      
      // 2. Price momentum (helps predict continuation vs mean reversion)
      const recent10Prices = historicalData.slice(-10).map(d => d.close);
      const recent20Prices = historicalData.slice(-20).map(d => d.close);
      
      if (recent10Prices.length >= 10 && recent20Prices.length >= 20) {
        const avg10 = recent10Prices.reduce((a, b) => a + b) / recent10Prices.length;
        const avg20 = recent20Prices.reduce((a, b) => a + b) / recent20Prices.length;
        const momentum = (avg10 - avg20) / avg20;
        priceVelocity = this.normalize(momentum, -0.1, 0.1); // 10% momentum range
      }
      
      // 3. Earnings proximity (quarterly pattern detection)
      earningsProximity = this.estimateEarningsRisk(historicalData, daysToExpiry);
    }
    
    return {
      moneyness: this.normalize(moneyness, 0.8, 1.3),
      timeToExpiry: this.normalize(timeToExpiry, 0, 1),
      volatility: this.normalize(iv, 0.1, 1.0),
      delta: this.normalize(Math.abs(delta), 0, 1),
      otmPercent: this.normalize(otmPercent, 0, 0.3),
      volumeRatio: this.normalize(volumeRatio, 0, 10),
      ivRank: ivRank,
      liquidityScore: liquidityScore,
      marketSentiment: marketSentiment,
      timeDecay: this.normalize(timeDecay, 0, 1),
      historicalVolTrend: historicalVolatilityTrend, // NEW: Vol increasing/decreasing
      priceVelocity: priceVelocity, // NEW: Recent price momentum  
      earningsRisk: earningsProximity // NEW: Earnings proximity risk
    };
  }

  // Simple normalization to 0-1 range
  normalize(value, min, max) {
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  // Calculate IV percentile (simplified)
  calculateIVPercentile(iv) {
    // Simple heuristic: typical IV ranges from 0.1 to 1.0
    return this.normalize(iv, 0.1, 1.0);
  }

  // Calculate historical volatility from price data (annualized)
  calculateHistoricalVol(priceData) {
    if (!priceData || priceData.length < 2) return 0.25; // Default 25%
    
    const returns = [];
    for (let i = 1; i < priceData.length; i++) {
      const return_ = Math.log(priceData[i].close / priceData[i-1].close);
      returns.push(return_);
    }
    
    if (returns.length === 0) return 0.25;
    
    const mean = returns.reduce((a, b) => a + b) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    const dailyVol = Math.sqrt(variance);
    
    return dailyVol * Math.sqrt(252); // Annualize (252 trading days)
  }

  // Estimate earnings risk based on quarterly patterns (anti-overfitting approach)
  estimateEarningsRisk(historicalData, daysToExpiry) {
    if (!historicalData || historicalData.length < 180 || daysToExpiry > 90) {
      return 0; // No earnings risk for long-term options
    }
    
    // Look for quarterly volatility spikes (earnings pattern detection)
    const recentData = historicalData.slice(-180); // 6 months
    const volatilitySpikes = [];
    
    // Calculate daily volatility
    for (let i = 1; i < recentData.length; i++) {
      const return_ = Math.abs(Math.log(recentData[i].close / recentData[i-1].close));
      volatilitySpikes.push(return_);
    }
    
    // Find the top 5% most volatile days (potential earnings days)
    volatilitySpikes.sort((a, b) => b - a);
    const top5Percent = Math.max(1, Math.floor(volatilitySpikes.length * 0.05));
    const earningsThreshold = volatilitySpikes[top5Percent - 1];
    
    // Look for recent high-volatility days that might indicate earnings pattern
    const recentHighVolDays = [];
    for (let i = recentData.length - 90; i < recentData.length - 1; i++) {
      if (i >= 1) {
        const dailyReturn = Math.abs(Math.log(recentData[i].close / recentData[i-1].close));
        if (dailyReturn >= earningsThreshold) {
          const daysAgo = recentData.length - 1 - i;
          recentHighVolDays.push(daysAgo);
        }
      }
    }
    
    // Estimate if we're approaching an earnings date based on quarterly pattern
    let earningsRisk = 0;
    if (recentHighVolDays.length > 0) {
      // Look for ~90 day patterns (quarterly earnings)
      const avgEarningsCycle = 90;
      for (const earningsDay of recentHighVolDays) {
        const daysSinceEarnings = earningsDay;
        const daysToNextEarnings = avgEarningsCycle - (daysSinceEarnings % avgEarningsCycle);
        
        if (daysToNextEarnings <= daysToExpiry + 7) { // Within a week of potential earnings
          const proximityRisk = Math.max(0, 1 - (daysToNextEarnings / 30)); // Higher risk as we get closer
          earningsRisk = Math.max(earningsRisk, proximityRisk);
        }
      }
    }
    
    return Math.min(1, earningsRisk); // Cap at 1.0
  }

  // Generate training data for the neural network
  generateNeuralTrainingData(symbol, historicalData, count = 500) {
    const trainingData = [];
    
    for (let i = 0; i < count; i++) {
      // Generate realistic training examples
      const basePrice = 100 + (Math.random() - 0.5) * 40; // $80-$120 range
      const strike = basePrice * (1 + Math.random() * 0.3); // 0-30% OTM
      const dte = 1 + Math.random() * 90; // 1-90 days
      const timeToExpiry = dte / 365;
      const iv = 0.15 + Math.random() * 0.85; // 15-100% IV
      const volume = Math.random() * 10000;
      const bid = 0.5 + Math.random() * 10;
      const ask = bid + Math.random() * 2;
      const openInterest = Math.random() * 50000;

      const features = this.extractFeatures(basePrice, strike, timeToExpiry, dte, iv, volume, bid, ask, openInterest, historicalData);
      
      // Calculate "true" assignment probability using enhanced Black-Scholes
      const delta = calculateDelta(basePrice, strike, timeToExpiry, 0.045, iv);
      const bsProb = calculateAssignmentProbability(basePrice, strike, timeToExpiry, 0.045, iv, delta);
      
      // Add some realistic noise and adjustments
      let targetProb = bsProb.enhanced;
      
      // Market adjustments
      if (dte < 7) targetProb *= 1.1; // Higher assignment risk near expiry
      if (iv > 0.5) targetProb *= 0.95; // High IV slightly reduces assignment probability
      if (features.liquidityScore < 0.3) targetProb *= 1.05; // Wide spreads increase assignment risk
      
      targetProb = Math.max(0, Math.min(1, targetProb));

      trainingData.push({
        input: features,
        output: { assignmentProbability: targetProb }
      });
    }

    return trainingData;
  }

  // Simplified training using gradient descent
  async train(symbol, historicalData) {
    console.log(`Training pure JS neural network for ${symbol}...`);
    
    const trainingData = this.generateNeuralTrainingData(symbol, historicalData);
    
    try {
      const epochs = 500; // Reduced for faster training
      let totalError = 0;
      
      for (let epoch = 0; epoch < epochs; epoch++) {
        totalError = 0;
        
        // Shuffle training data
        for (let i = trainingData.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [trainingData[i], trainingData[j]] = [trainingData[j], trainingData[i]];
        }
        
        for (const sample of trainingData) {
          const inputs = Object.values(sample.input);
          const target = sample.output.assignmentProbability;
          
          // Forward pass
          const result = this.forward(inputs);
          const output = result.output;
          
          // Calculate error
          const error = target - output;
          totalError += error * error;
          
          // Simplified backpropagation (just adjust output layer for speed)
          const outputDelta = error * this.sigmoidDerivative(output);
          
          // Update weights and bias for output layer only (simplified)
          for (let i = 0; i < 8; i++) {
            this.weights3[i][0] += this.learningRate * outputDelta * result.hidden2[i];
          }
          this.bias3[0] += this.learningRate * outputDelta;
        }
        
        // Early stopping if error is low enough
        if (totalError < 0.01) break;
      }
      
      this.isTrained = true;
      const avgError = totalError / trainingData.length;
      console.log(`Neural network trained for ${symbol}. Average error: ${avgError.toFixed(4)}`);
      return { error: avgError };
      
    } catch (error) {
      console.warn(`Neural network training failed for ${symbol}:`, error.message);
      throw error;
    }
  }

  // Predict assignment probability
  predict(currentPrice, strike, timeToExpiry, daysToExpiry, iv, volume, bid, ask, openInterest, historicalData = null) {
    if (!this.isTrained) {
      throw new Error('Neural network not trained');
    }

    const features = this.extractFeatures(currentPrice, strike, timeToExpiry, daysToExpiry, iv, volume, bid, ask, openInterest, historicalData);
    const inputs = Object.values(features);
    const result = this.forward(inputs);
    
    return result.output;
  }
}

// Calculate IV Rank for a symbol (simplified version)
async function calculateIVRank(symbol) {
  try {
    console.log(`Calculating IV rank for ${symbol}...`);
    
    // Try multiple approaches to get current IV
    let currentIV = null;
    
    // Approach 1: Try summaryDetail
    try {
      const quote = await yf.quoteSummary(symbol, { modules: ['summaryDetail'] });
      currentIV = quote?.summaryDetail?.impliedVolatility;
      console.log(`SummaryDetail IV for ${symbol}:`, currentIV);
    } catch (e) {
      console.warn(`Failed to get IV from summaryDetail:`, e.message);
    }
    
    // Approach 2: Try to get IV from options chain
    if (!currentIV) {
      try {
        const optionsBase = await yf.options(symbol);
        if (optionsBase?.expirationDates?.[0]) {
          const chain = await yf.options(symbol, { date: optionsBase.expirationDates[0] });
          const atm = chain?.options?.[0]?.calls?.find(c => c.inTheMoney === false);
          if (atm?.impliedVolatility) {
            currentIV = atm.impliedVolatility;
            console.log(`Options chain IV for ${symbol}:`, currentIV);
          }
        }
      } catch (e) {
        console.warn(`Failed to get IV from options chain:`, e.message);
      }
    }
    
    if (!currentIV) {
      console.warn(`No IV data available for ${symbol}`);
      return null;
    }
    
    // Get historical price data to estimate historical IV range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - 1); // 1 year lookback
    
    const historicalData = await yf.historical(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d'
    });
    
    if (!historicalData || historicalData.length < 100) return null;
    
    // Calculate historical volatility as proxy for IV range
    const returns = [];
    for (let i = 1; i < historicalData.length; i++) {
      const return_ = Math.log(historicalData[i].close / historicalData[i-1].close);
      returns.push(return_);
    }
    
    // Calculate rolling 20-day volatilities to approximate IV range
    const rollingVols = [];
    for (let i = 19; i < returns.length; i++) {
      const windowReturns = returns.slice(i-19, i+1);
      const mean = windowReturns.reduce((a, b) => a + b) / windowReturns.length;
      const variance = windowReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / windowReturns.length;
      const vol = Math.sqrt(variance * 252); // Annualized
      rollingVols.push(vol);
    }
    
    if (rollingVols.length === 0) return null;
    
    const minVol = Math.min(...rollingVols);
    const maxVol = Math.max(...rollingVols);
    
    // Calculate IV rank (0-100%)
    const ivRank = ((currentIV - minVol) / (maxVol - minVol)) * 100;
    
    const result = {
      currentIV: currentIV,
      ivRank: Math.max(0, Math.min(100, ivRank)),
      minIV: minVol,
      maxIV: maxVol
    };
    
    console.log(`IV Rank calculation for ${symbol}:`, result);
    return result;
    
  } catch (error) {
    console.warn(`Could not calculate IV rank for ${symbol}:`, error.message);
    return null;
  }
}

// Get earnings date for a symbol
async function getEarningsDate(symbol) {
  try {
    // Try to get earnings calendar from Yahoo Finance
    const quote = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] });
    const earnings = quote?.calendarEvents?.earnings;
    
    if (earnings && earnings.earningsDate && earnings.earningsDate.length > 0) {
      // Yahoo Finance sometimes provides date ranges, take the first (earliest) date
      const earningsDate = earnings.earningsDate[0];
      return new Date(earningsDate);
    }
    
    // Fallback: try to get from company financials
    const financials = await yf.quoteSummary(symbol, { modules: ['financialData'] });
    // This is a fallback - real implementation might need different approach
    
    return null;
  } catch (error) {
    console.warn(`Could not fetch earnings date for ${symbol}:`, error.message);
    return null;
  }
}

// RF Analysis endpoint
app.get('/api/analyze-rf/:symbol', async (req, res) => {
  const symbol = toUpperNoSpaces(req.params.symbol);
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  
  try {
    console.log(`Starting RF analysis for ${symbol}...`);
    
    // Get historical data for training (1 year)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - 1);
    
    const historicalData = await yf.historical(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d'
    });
    
    if (!historicalData || historicalData.length < 100) {
      return res.status(400).json({ error: 'Insufficient historical data for RF training' });
    }
    
    // Train or get cached model
    if (!trainedModels[symbol]) {
      console.log(`Training RF model for ${symbol}...`);
      const { features, targets } = generateTrainingData(symbol, historicalData);
      
      const model = new SimpleRandomForest(120, 10, 5);
      model.train(features, targets);
      
      // Calculate simple accuracy metrics on training data
      const predictions = model.predict(features);
      const mae = predictions.reduce((sum, pred, i) => sum + Math.abs(pred - targets[i]), 0) / predictions.length;
      const variance = targets.reduce((sum, t) => sum + (t - targets.reduce((a, b) => a + b) / targets.length) ** 2, 0) / targets.length;
      const mse = predictions.reduce((sum, pred, i) => sum + (pred - targets[i]) ** 2, 0) / predictions.length;
      const r2 = 1 - (mse / variance);
      
      trainedModels[symbol] = { model, stats: { mae, r2 } };
      console.log(`RF model trained for ${symbol}. MAE=${mae.toFixed(4)}, R2=${r2.toFixed(4)}`);
    }
    
    const { model, stats } = trainedModels[symbol];
    
    // Get earnings date and IV rank
    const [earningsDate, ivRankData] = await Promise.all([
      getEarningsDate(symbol),
      calculateIVRank(symbol)
    ]);
    
    // Get current options data
    const quote = await yf.quoteSummary(symbol, { modules: ['price'] });
    const currentPrice = quote?.price?.regularMarketPrice;
    if (!currentPrice) {
      return res.status(400).json({ error: 'Unable to get current price' });
    }
    
    const optionsBase = await yf.options(symbol);
    const expirations = optionsBase?.expirationDates || [];
    if (!expirations.length) {
      return res.status(404).json({ error: 'No options available' });
    }
    
    // Get expirations ensuring at least one in 20s, 30s, and 40s DTE (contiguous)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get all future expirations with DTE calculations
    const allFutureExpirations = expirations
      .filter(exp => exp.getTime() >= today.getTime())
      .map(exp => ({
        date: exp,
        dte: Math.round((exp.getTime() - Date.now()) / (1000 * 3600 * 24))
      }))
      .sort((a, b) => a.dte - b.dte); // Sort by DTE ascending
    
    // Find candidates for each DTE range
    const range20s = allFutureExpirations.filter(exp => exp.dte >= 20 && exp.dte <= 29);
    const range30s = allFutureExpirations.filter(exp => exp.dte >= 30 && exp.dte <= 39);
    const range40s = allFutureExpirations.filter(exp => exp.dte >= 40 && exp.dte <= 49);
    
    const selectedExpirations = [];
    
    // Pick one from each range (closest to middle of range)
    if (range20s.length > 0) {
      const target = range20s.find(exp => exp.dte >= 24) || range20s[Math.floor(range20s.length / 2)];
      selectedExpirations.push(target);
    }
    if (range30s.length > 0) {
      const target = range30s.find(exp => exp.dte >= 34) || range30s[Math.floor(range30s.length / 2)];
      selectedExpirations.push(target);
    }
    if (range40s.length > 0) {
      const target = range40s.find(exp => exp.dte >= 44) || range40s[Math.floor(range40s.length / 2)];
      selectedExpirations.push(target);
    }
    
    // If we don't have all three ranges, fill gaps with nearest available expirations
    while (selectedExpirations.length < 3 && allFutureExpirations.length > selectedExpirations.length) {
      const used = new Set(selectedExpirations.map(exp => exp.date.getTime()));
      const remaining = allFutureExpirations.filter(exp => !used.has(exp.date.getTime()));
      if (remaining.length > 0) {
        selectedExpirations.push(remaining[0]); // Add the nearest unused expiration
      } else {
        break;
      }
    }
    
    // Sort final selection chronologically and extract dates
    const futureExpirations = selectedExpirations
      .sort((a, b) => a.dte - b.dte)
      .map(exp => exp.date);
    
    const otmLow = currentPrice * 1.001;
    const otmHigh = currentPrice * 1.25; // 25% OTM limit like notebook
    
    const weeksData = [];
    
    for (const expDate of futureExpirations) {
      try {
        const chain = await yf.options(symbol, { date: expDate });
        const opt = chain?.options?.[0];
        if (!opt?.calls) continue;
        
        const daysToExpiry = (expDate.getTime() - Date.now()) / (1000 * 3600 * 24);
        const timeToExpiry = daysToExpiry / 365.0;
        
        // Check if this expiration is in optimal DTE range (expanded to include 40s)
        const isOptimalDTE = daysToExpiry >= 30 && daysToExpiry <= 49;
        
        // Check if earnings occurs before this expiration
        let earningsWarning = null;
        if (earningsDate && earningsDate.getTime() < expDate.getTime() && earningsDate.getTime() > Date.now()) {
          const daysToEarnings = (earningsDate.getTime() - Date.now()) / (1000 * 3600 * 24);
          earningsWarning = {
            hasEarnings: true,
            earningsDate: earningsDate.toISOString(),
            daysToEarnings: Math.round(daysToEarnings)
          };
        }
        
        const processedOptions = [];
        let bestOption = null;
        
        for (const call of opt.calls) {
          if (call.strike < otmLow || call.strike > otmHigh) continue;
          
          // Minimum liquidity requirements
          const minVol = daysToExpiry <= 16 ? 10 : 1;
          const minOi = daysToExpiry <= 16 ? 50 : 10;
          if ((call.volume || 0) < minVol || (call.openInterest || 0) < minOi) continue;
          
          const bid = call.bid || 0;
          const ask = call.ask || 0;
          if (bid <= 0 || ask <= 0) continue;
          
          const mid = (bid + ask) / 2;
          const spreadPct = (ask - bid) / Math.max(mid, 1e-9);
          if (spreadPct > 0.5) continue; // Skip wide spreads
          
          const iv = call.impliedVolatility || 0.25;
          const delta = calculateDelta(currentPrice, call.strike, timeToExpiry, 0.045, iv);
          const bsProbs = calculateAssignmentProbability(currentPrice, call.strike, timeToExpiry, 0.045, iv, delta);
          
          // Get RF prediction
          const features = [
            currentPrice / call.strike, // moneyness
            daysToExpiry,
            iv,
            delta,
            (call.strike - currentPrice) / currentPrice, // otm percent
            (call.volume || 0) / 1_000_000, // volume in millions
            bsProbs.enhanced
          ];
          
          let rfProb = bsProbs.enhanced;
          try {
            rfProb = Math.max(0, Math.min(1, model.predict([features])[0]));
          } catch (e) {
            console.warn(`RF prediction failed, using BS: ${e.message}`);
          }
          
          // Blended probability: RF + BS with market adjustments
          let blendedProb = (rfProb * 0.7) + (bsProbs.enhanced * 0.3); // 70% RF, 30% enhanced BS
          
          // Add market adjustments
          const borrowFee = 0.0; // Default to 0 for now
          blendedProb += 0.01 * (borrowFee / 10.0);
          
          const sentiment = 0.0; // Default to 0 for now  
          blendedProb += 0.02 * sentiment;
          
          // Ensure probability stays within bounds
          blendedProb = Math.max(0, Math.min(1, blendedProb));
          
          const otmFrac = (call.strike - currentPrice) / currentPrice;
          if (otmFrac < 0.02 || (blendedProb * 100) > 25.0) continue; // Skip if too ITM or high assignment risk
          
          const returnPct = (mid / currentPrice) * 100;
          
          // Check return targets
          const meetsWeeklyTarget = daysToExpiry <= 8 && returnPct >= 0.05;
          const meetsBiweeklyTarget = daysToExpiry <= 16 && returnPct >= 0.10;
          const meetsTarget = meetsWeeklyTarget || meetsBiweeklyTarget;
          
          if (daysToExpiry <= 16 && !meetsTarget) continue; // Skip if doesn't meet targets for short-term
          
          const months = Math.max(1, Math.ceil(daysToExpiry / 30));
          const annualYield = returnPct * (12 / months);
          
          const optionData = {
            strike: call.strike,
            premium: mid.toFixed(2),
            returnPercent: returnPct.toFixed(3),
            annualYield: annualYield.toFixed(1),
            otmPercent: (otmFrac * 100).toFixed(2),
            assignmentProbability: (blendedProb * 100).toFixed(1),
            openInterest: call.openInterest,
            volume: call.volume,
            daysToExpiry: Math.round(daysToExpiry)
          };
          
          processedOptions.push(optionData);
          
          // Find best option (prefer farther OTM and lower blended probability)
          if (!bestOption || (otmFrac > (bestOption.strike - currentPrice) / currentPrice && blendedProb < bestOption.assignmentProbability / 100)) {
            bestOption = optionData;
          }
        }
        
        processedOptions.sort((a, b) => a.strike - b.strike);
        
        weeksData.push({
          expiration: expDate.toISOString(),
          daysToExpiry: Math.round(daysToExpiry),
          isOptimalDTE: isOptimalDTE,
          options: processedOptions,
          bestOption: bestOption,
          earningsWarning: earningsWarning
        });
        
      } catch (e) {
        console.warn(`Failed to process expiration ${expDate}: ${e.message}`);
      }
    }
    
    res.json({
      symbol,
      currentPrice,
      modelStats: stats,
      otmRange: { low: otmLow, high: otmHigh },
      earningsDate: earningsDate ? earningsDate.toISOString() : null,
      ivRankData: ivRankData,
      dteRange: { target: 37.5, min: 30, max: 49 },
      weeksData
    });
    
  } catch (err) {
    console.error(`RF analysis error for ${symbol}:`, err);
    res.status(500).json({ error: 'RF analysis failed', details: err?.message });
  }
});

// Get all options data for a symbol (all strikes, all DTEs)
app.get('/api/all-options/:symbol', async (req, res) => {
  const symbol = toUpperNoSpaces(req.params.symbol);
  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }

  try {
    console.log(`Fetching all options data for ${symbol}...`);

    // Get current stock price
    const quote = await yf.quoteSummary(symbol, { modules: ['price'] });
    const currentPrice = quote?.price?.regularMarketPrice;
    if (!currentPrice || !Number.isFinite(currentPrice)) {
      return res.status(400).json({ error: 'Unable to get current stock price' });
    }

    // Get all available expiration dates
    const base = await yf.options(symbol);
    const expirations = base?.expirationDates || [];
    if (!expirations.length) {
      return res.status(404).json({ error: 'No options available' });
    }

    // Sort expirations chronologically
    const sortedExpirations = expirations.sort((a, b) => a.getTime() - b.getTime());
    
    // Get current date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Filter to future expirations only
    const futureExpirations = sortedExpirations.filter(exp => exp.getTime() >= today.getTime());

    const results = [];

    // Fetch options chain for each expiration
    for (const expDate of futureExpirations) {
      try {
        console.log(`Fetching options for expiration: ${expDate.toISOString()}`);
        
        const chain = await yf.options(symbol, { date: expDate });
        const opt = chain?.options?.[0];
        
        if (!opt) {
          console.warn(`No options data for expiration: ${expDate.toISOString()}`);
          continue;
        }

        const daysToExpiry = (expDate.getTime() - Date.now()) / (1000 * 3600 * 24);
        const timeToExpiry = daysToExpiry / 365.0;
        
        // Get or create Neural Network model for this symbol
        let neuralNet = null;
        let historicalData = null;
        
        if (neuralNetworks[symbol]) {
          neuralNet = neuralNetworks[symbol];
        }
        
        // Always fetch historical data for enhanced features (even if NN exists)
        try {
          const endDate = new Date();
          const startDate = new Date();
          startDate.setFullYear(endDate.getFullYear() - 1);
          
          historicalData = await yf.historical(symbol, {
            period1: startDate,
            period2: endDate,
            interval: '1d'
          });
          
          // Train neural network if none exists
          if (!neuralNet && historicalData && historicalData.length >= 100) {
            neuralNet = new LightweightAssignmentPredictor();
            const stats = await neuralNet.train(symbol, historicalData);
            
            neuralNetworks[symbol] = neuralNet;
            console.log(`Trained neural network for ${symbol} with enhanced features. Error: ${stats.error}`);
          }
        } catch (e) {
          console.warn(`Could not fetch historical data or train neural network for ${symbol}: ${e.message}`);
        }

        // Process calls with additional calculations - filter to OTM only
        const calls = (opt.calls || [])
          .filter(call => call.strike > currentPrice) // Only OTM calls
          .map(call => {
            const bid = call.bid || 0;
            const ask = call.ask || 0;
            const mid = (bid + ask) / 2;
            // Use last traded price as primary premium; fallback to mid
            const last = (call.lastPrice || 0);
            const premium = (last > 0 ? last : (mid || 0));
            
            // Calculate intrinsic and extrinsic values for calls
            const intrinsic = Math.max(currentPrice - call.strike, 0);
            const extrinsic = Math.max(premium - intrinsic, 0);
            
            // Calculate OTM percentage
            const otmPercent = ((call.strike - currentPrice) / currentPrice * 100).toFixed(2);
            
            // Calculate return percentage (premium as % of stock price)
            const returnPercent = premium > 0 && currentPrice > 0 ? 
              (premium / currentPrice * 100).toFixed(3) : '0.000';
            
            // Calculate annualized yield
            const months = Math.max(1, Math.ceil(daysToExpiry / 30));
            const annualYield = returnPercent > 0 ? 
              (parseFloat(returnPercent) * (12 / months)).toFixed(1) : '0.0';
            
            // Calculate Neural Network assignment probability
            let assignmentProbability = '0.0';
            if (neuralNet && premium > 0) {
              try {
                const iv = call.impliedVolatility || 0.25;
                
                // Use neural network prediction with historical context
                const neuralProb = neuralNet.predict(
                  currentPrice, 
                  call.strike, 
                  timeToExpiry, 
                  daysToExpiry, 
                  iv, 
                  call.volume || 0, 
                  bid, 
                  ask, 
                  call.openInterest || 0,
                  historicalData
                );
                
                // Calculate Black-Scholes as fallback/blend
                const delta = calculateDelta(currentPrice, call.strike, timeToExpiry, 0.045, iv);
                const bsProbs = calculateAssignmentProbability(currentPrice, call.strike, timeToExpiry, 0.045, iv, delta);
                
                // Ensemble: 50% Neural Network + 50% Enhanced Black-Scholes
                let blendedProb = (neuralProb * 0.5) + (bsProbs.enhanced * 0.5);
                blendedProb = Math.max(0, Math.min(1, blendedProb));
                
                assignmentProbability = (blendedProb * 100).toFixed(1);
              } catch (e) {
                console.warn(`Error calculating neural assignment probability for ${call.strike}: ${e.message}`);
                
                // Fallback to enhanced Black-Scholes if neural network fails
                try {
                  const iv = call.impliedVolatility || 0.25;
                  const delta = calculateDelta(currentPrice, call.strike, timeToExpiry, 0.045, iv);
                  const bsProbs = calculateAssignmentProbability(currentPrice, call.strike, timeToExpiry, 0.045, iv, delta);
                  assignmentProbability = (bsProbs.enhanced * 100).toFixed(1);
                } catch (fallbackError) {
                  console.warn(`Fallback BS calculation also failed for ${call.strike}:`, fallbackError.message);
                }
              }
            } else if (premium > 0) {
              // Fallback to Black-Scholes if no neural network
              try {
                const iv = call.impliedVolatility || 0.25;
                const delta = calculateDelta(currentPrice, call.strike, timeToExpiry, 0.045, iv);
                const bsProbs = calculateAssignmentProbability(currentPrice, call.strike, timeToExpiry, 0.045, iv, delta);
                assignmentProbability = (bsProbs.enhanced * 100).toFixed(1);
              } catch (e) {
                console.warn(`Fallback BS calculation failed for ${call.strike}:`, e.message);
              }
            }

            return {
              contractSymbol: call.contractSymbol,
              strike: call.strike,
              last: (last > 0 ? last : 0).toFixed(2),
              intrinsic: intrinsic.toFixed(2),
              extrinsic: extrinsic.toFixed(2),
              volume: call.volume,
              openInterest: call.openInterest,
              impliedVolatility: call.impliedVolatility,
              otmPercent: otmPercent,
              returnPercent: returnPercent,
              annualYield: annualYield,
              assignmentProbability: assignmentProbability
            };
          });

        // Sort calls by strike price
        calls.sort((a, b) => a.strike - b.strike);

        results.push({
          expiration: Math.floor((opt.expirationDate?.getTime?.() || expDate.getTime()) / 1000),
          calls: calls
        });

      } catch (e) {
        console.warn(`Failed to fetch options for expiration ${expDate}: ${e.message}`);
        continue;
      }
    }

    console.log(`Successfully fetched options data for ${symbol}: ${results.length} expirations`);

    res.json({
      symbol,
      currentPrice,
      expirations: results
    });

  } catch (err) {
    console.error(`Failed to fetch all options for ${symbol}:`, err);
    res.status(500).json({ error: 'Failed to fetch options data', details: err?.message });
  }
});

// Export for Vercel
module.exports = app;
