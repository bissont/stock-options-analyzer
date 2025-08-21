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
  res.json({ ok: true });
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
    
    // Get next 4 expirations
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const futureExpirations = expirations
      .filter(exp => exp.getTime() >= today.getTime())
      .sort((a, b) => a.getTime() - b.getTime())
      .slice(0, 4);
    
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
          options: processedOptions,
          bestOption: bestOption
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
      weeksData
    });
    
  } catch (err) {
    console.error(`RF analysis error for ${symbol}:`, err);
    res.status(500).json({ error: 'RF analysis failed', details: err?.message });
  }
});

// Export for Vercel
module.exports = app;