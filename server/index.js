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

function calculateDelta(currentPrice, strikePrice, timeToExpiry, riskFreeRate, volatility, optionType = 'call', dividendYield = 0) {
  if (timeToExpiry <= 0) return optionType === 'call' ? (currentPrice > strikePrice ? 1 : 0) : (currentPrice < strikePrice ? -1 : 0);

  const S = currentPrice;
  const K = strikePrice;
  const T = timeToExpiry;
  const r = riskFreeRate;
  const q = dividendYield || 0;
  const sigma = volatility;

  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));

  if (optionType === 'call') {
    return Math.exp(-q * T) * normalCDF(d1);
  } else {
    return Math.exp(-q * T) * (normalCDF(d1) - 1);
  }
}

function calculateAssignmentProbability(currentPrice, strikePrice, timeToExpiry, riskFreeRate, volatility, _marketDelta = null, dividendYield = 0) {
  // This function now returns:
  // - original: Black–Scholes probability without dividends (legacy)
  // - enhanced: Black–Scholes probability with dividend yield q
  if (timeToExpiry <= 0) return {
    original: strikePrice <= currentPrice ? 1 : 0,
    enhanced: strikePrice <= currentPrice ? 1 : 0
  };

  const S = currentPrice;
  const K = strikePrice;
  const T = timeToExpiry;
  const r = riskFreeRate;
  const q = dividendYield || 0;
  const sigma = volatility;

  // Legacy original (q = 0)
  const d1_legacy = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2_legacy = d1_legacy - sigma * Math.sqrt(T);
  const originalProb = normalCDF(d2_legacy);

  // Dividend-aware BS
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const enhancedProb = normalCDF(d2);

  return { original: originalProb, enhanced: enhancedProb };
}

// Compute mid price helper
function midPrice(opt) {
  const bid = Number(opt?.bid) || 0;
  const ask = Number(opt?.ask) || 0;
  const last = Number(opt?.lastPrice) || 0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (last > 0) return last;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return 0;
}

// Estimate dividend yield q from put–call parity at near-ATM strike
function estimateDividendYieldFromParity(S, r, T, calls, puts) {
  try {
    if (!Array.isArray(calls) || !Array.isArray(puts) || calls.length === 0 || puts.length === 0) return null;
    const callsSorted = [...calls].filter(c => c && Number.isFinite(c.strike)).sort((a, b) => a.strike - b.strike);
    const putsSorted = [...puts].filter(p => p && Number.isFinite(p.strike)).sort((a, b) => a.strike - b.strike);
    let best = null;
    for (const c of callsSorted) {
      // find matching put by strike
      const p = putsSorted.find(pp => Math.abs(pp.strike - c.strike) < 1e-6);
      if (!p) continue;
      const K = c.strike;
      const C = midPrice(c);
      const P = midPrice(p);
      if (!(C > 0 && P >= 0)) continue;
      const numerator = C - P + K * Math.exp(-r * T);
      if (numerator <= 0) continue;
      const ratio = numerator / S;
      if (!(ratio > 0)) continue;
      const q = - (1 / T) * Math.log(ratio);
      const moneyness = Math.abs(S - K) / S;
      if (!Number.isFinite(q)) continue;
      if (!best || moneyness < best.moneyness) best = { q, moneyness };
    }
    return best ? Math.max(0, Math.min(1, best.q)) : null;
  } catch {
    return null;
  }
}

// Risk-neutral probability via digital approximation from call surface
function estimateRiskNeutralProbFromCalls(callsSortedAsc, idx, r, T) {
  try {
    if (!Array.isArray(callsSortedAsc) || callsSortedAsc.length < 3) return null;
    if (idx <= 0 || idx >= callsSortedAsc.length - 1) return null;
    const cMinus = callsSortedAsc[idx - 1];
    const c = callsSortedAsc[idx];
    const cPlus = callsSortedAsc[idx + 1];
    const Kminus = cMinus.strike;
    const Kplus = cPlus.strike;
    const Cminus = midPrice(cMinus);
    const Cplus = midPrice(cPlus);
    const dK = Kplus - Kminus;
    if (!(dK > 0)) return null;
    const digital = (Cminus - Cplus) / dK; // ∂C/∂K ≈ -e^{-rT} P(S_T > K)
    const prob = Math.exp(r * T) * Math.max(0, Math.min(1, digital));
    if (!Number.isFinite(prob)) return null;
    return Math.max(0, Math.min(1, prob));
  } catch {
    return null;
  }
}

// Early assignment probability approximation for calls around ex-div
function estimateEarlyAssignmentProbabilityCall(S, K, T_to_expiry, T_to_exdiv, r, expectedDividend, callMid, bsProbITMAtExDiv) {
  try {
    if (!(T_to_exdiv > 0) || !(T_to_exdiv < T_to_expiry) || !(expectedDividend > 0)) return 0;
    const intrinsic = Math.max(S - K, 0);
    const extrinsic = Math.max(callMid - intrinsic, 0);
    const pvDiv = expectedDividend * Math.exp(-r * T_to_exdiv);
    // Logistic gating on (pvDiv - extrinsic)
    const x = pvDiv - extrinsic;
    const scale = Math.max(0.05, 0.25); // in $; conservative scale
    const logistic = 1 / (1 + Math.exp(-x / scale));
    const p_early = logistic * bsProbITMAtExDiv;
    return Math.max(0, Math.min(1, p_early));
  } catch {
    return 0;
  }
}

async function getDividendInfo(symbol) {
  try {
    const data = await yf.quoteSummary(symbol, { modules: ['summaryDetail', 'calendarEvents'] });
    const yieldRaw = data?.summaryDetail?.dividendYield;
    const dividendRate = data?.summaryDetail?.dividendRate; // annual amount
    const exDivRaw = data?.calendarEvents?.exDividendDate || data?.summaryDetail?.exDividendDate;
    const exDividendDate = exDivRaw ? new Date(exDivRaw) : null;
    const dividendYield = Number(yieldRaw) || null; // already decimal (e.g., 0.02)
    const dividendRateAnnual = Number(dividendRate) || null;
    return { dividendYield, dividendRateAnnual, exDividendDate };
  } catch {
    return { dividendYield: null, dividendRateAnnual: null, exDividendDate: null };
  }
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

    // Fetch dividend info once
    const divInfo = await getDividendInfo(symbol);

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
      
      // Common variables for this expiration
      const timeToExpiry = (target.getTime() - Date.now()) / (1000 * 3600 * 24 * 365); // Years
      const daysToExpiry = (target.getTime() - Date.now()) / (1000 * 3600 * 24); // Days
      const riskFreeRate = 0.045;
      // Estimate dividend yield q: prefer summaryDetail, else parity
      let dividendYield = divInfo.dividendYield;
      if (dividendYield == null) {
        const qParity = estimateDividendYieldFromParity(currentPrice, riskFreeRate, timeToExpiry, opt.calls || [], opt.puts || []);
        if (qParity != null) dividendYield = qParity;
      }
      dividendYield = dividendYield || 0;

      const callsSorted = (opt.calls || []).filter(c => Number.isFinite(c?.strike)).sort((a, b) => a.strike - b.strike);

      const mapOption = (o) => {
        const iv = o.impliedVolatility || 0.25;
        const K = o.strike;
        const premium = midPrice(o);

        // Delta with dividends
        const theoreticalDelta = calculateDelta(currentPrice, K, timeToExpiry, riskFreeRate, iv, 'call', dividendYield);

        // BS probabilities
        const probsBS = calculateAssignmentProbability(currentPrice, K, timeToExpiry, riskFreeRate, iv, null, dividendYield);

        // Digital approximation
        const idx = callsSorted.findIndex(c => Math.abs(c.strike - K) < 1e-9);
        const digitalProb = estimateRiskNeutralProbFromCalls(callsSorted, idx, riskFreeRate, timeToExpiry);
        const chosenProb = (digitalProb != null) ? digitalProb : probsBS.enhanced;

        // Early assignment handling (ex-div before expiry)
        let finalProb = chosenProb;
        let earlyProb = 0;
        const exDivDate = divInfo.exDividendDate;
        let earlyNote = '';
        if (exDivDate && exDivDate.getTime() > Date.now() && exDivDate.getTime() < target.getTime()) {
          const T_ex = (exDivDate.getTime() - Date.now()) / (1000 * 3600 * 24 * 365);
          const bsAtExDiv = calculateAssignmentProbability(currentPrice, K, T_ex, riskFreeRate, iv, null, dividendYield);
          const expectedDividend = divInfo.dividendRateAnnual ? (divInfo.dividendRateAnnual / 4) : 0; // approx quarterly
          const pEarly = estimateEarlyAssignmentProbabilityCall(
            currentPrice, K, timeToExpiry, T_ex, riskFreeRate, expectedDividend, premium, bsAtExDiv.enhanced
          );
          earlyProb = pEarly;
          finalProb = pEarly + (1 - pEarly) * chosenProb;
          if (pEarly > 0.01) earlyNote = ' (ex-div early risk)';
        }

        const returnPercentStr = premium > 0 ? ((premium / currentPrice) * 100).toFixed(3) : '0.000';
        const goalScore = calculateGoalBasedScore(premium, finalProb * 100, K, currentPrice, daysToExpiry);

        const originalRatio = premium > 0 && probsBS.original > 0 ? (((premium / currentPrice) * 100) / (probsBS.original * 100)).toFixed(3) : 'N/A';
        const enhancedRatio = premium > 0 && finalProb > 0 ? (((premium / currentPrice) * 100) / (finalProb * 100)).toFixed(3) : 'N/A';

        const weeklyReturn = premium > 0 ? (premium / currentPrice) * 100 : 0;
        const meetsWeeklyTarget = daysToExpiry <= 8 && weeklyReturn >= 0.1;
        const meetsBiweeklyTarget = daysToExpiry <= 16 && weeklyReturn >= 0.2;
        const meetsTarget = meetsWeeklyTarget || meetsBiweeklyTarget;
        const targetType = meetsWeeklyTarget ? 'weekly' : (meetsBiweeklyTarget ? 'bi-weekly' : 'none');

        return {
          contractSymbol: o.contractSymbol,
          strike: K,
          lastPrice: o.lastPrice,
          bid: o.bid,
          ask: o.ask,
          change: o.change,
          percentChange: o.percentChange,
          volume: o.volume,
          openInterest: o.openInterest,
          impliedVolatility: o.impliedVolatility,
          inTheMoney: o.inTheMoney,
          otmPercent: ((K - currentPrice) / currentPrice * 100).toFixed(2),
          assignmentProbability: (probsBS.original * 100).toFixed(1),
          assignmentProbabilityEnhanced: (finalProb * 100).toFixed(1),
          delta: (theoreticalDelta * 100).toFixed(1),
          premium: premium.toFixed(2),
          returnPercent: returnPercentStr,
          goalScore: goalScore > 0 ? goalScore.toFixed(3) : enhancedRatio,
          returnAssignmentRatio: originalRatio,
          returnAssignmentRatioEnhanced: enhancedRatio,
          meetsTarget: meetsTarget,
          targetType: targetType,
          daysToExpiry: Math.round(daysToExpiry),
          notes: earlyNote
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

// Web scraping endpoint for Yahoo Finance options page
app.get('/api/scrape-options/:symbol', async (req, res) => {
  const symbol = toUpperNoSpaces(req.params.symbol);
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  
  try {
    console.log(`Scraping options data for ${symbol}...`);
    
    // Get the options page HTML
    const url = `https://finance.yahoo.com/quote/${symbol}/options/`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000
    });
    
    const html = response.data;
    
    // Look for JSON data in script tags (Yahoo often embeds data this way)
    const jsonMatches = html.match(/root\.App\.main\s*=\s*({.+?});/);
    if (jsonMatches) {
      const data = JSON.parse(jsonMatches[1]);
      const quoteSummary = data?.context?.dispatcher?.stores?.QuoteSummaryStore;
      const optionsData = quoteSummary?.optionsData;
      
      if (optionsData && optionsData.options && optionsData.options.length > 0) {
        const options = optionsData.options[0];
        const calls = options.calls || [];
        const puts = options.puts || [];
        
        console.log(`Found ${calls.length} calls and ${puts.length} puts via scraping`);
        
        return res.json({
          symbol: symbol,
          currentPrice: quoteSummary?.price?.regularMarketPrice?.raw,
          expiration: options.expirationDate,
          calls: calls.map(call => ({
            strike: call.strike?.raw,
            bid: call.bid?.raw,
            ask: call.ask?.raw,
            lastPrice: call.lastPrice?.raw,
            volume: call.volume?.raw,
            openInterest: call.openInterest?.raw,
            impliedVolatility: call.impliedVolatility?.raw,
            inTheMoney: call.inTheMoney
          })),
          source: 'scraped'
        });
      }
    }
    
    // Fallback: look for table data patterns
    const tableMatches = html.match(/strike.*?bid.*?ask/gi);
    if (tableMatches) {
      console.log(`Found potential options table data via scraping`);
      return res.json({
        symbol: symbol,
        message: 'Found options table but parsing not implemented yet',
        tableDataFound: tableMatches.length,
        source: 'scraped-partial'
      });
    }
    
    return res.status(404).json({ 
      error: 'No options data found in scraped page',
      source: 'scraped-failed'
    });
    
  } catch (err) {
    console.error(`Scraping failed for ${symbol}:`, err.message);
    return res.status(500).json({ 
      error: 'Failed to scrape options data', 
      details: err?.message,
      source: 'scraped-error'
    });
  }
});

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
    
    // Take the 6 closest future expirations (minimum 1 DTE to include more options)
    const futureExpirations = allFutureExpirations
      .filter(exp => exp.dte >= 1) // Include very short term too
      .slice(0, 6) // Take first 6
      .map(exp => exp.date);
    
    const otmLow = currentPrice * 1.001; // Just above current price
    const otmHigh = currentPrice * 2.0; // Expand to 100% OTM to get more strikes
    
    const weeksData = [];
    const divInfo = await getDividendInfo(symbol);
    
    for (const expDate of futureExpirations) {
      try {
        const chain = await yf.options(symbol, { date: expDate });
        const opt = chain?.options?.[0];
        if (!opt?.calls) continue;
        
        const daysToExpiry = (expDate.getTime() - Date.now()) / (1000 * 3600 * 24);
        const timeToExpiry = daysToExpiry / 365.0;
        const riskFreeRate = 0.045;
        let dividendYield = divInfo.dividendYield;
        if (dividendYield == null) {
          const qParity = estimateDividendYieldFromParity(currentPrice, riskFreeRate, timeToExpiry, opt.calls || [], opt.puts || []);
          if (qParity != null) dividendYield = qParity;
        }
        dividendYield = dividendYield || 0;

        const callsSorted = (opt.calls || []).filter(c => Number.isFinite(c?.strike)).sort((a, b) => a.strike - b.strike);
        
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
        
        // Get all OTM calls and sort by strike
        const otmCalls = opt.calls
          .filter(call => call.strike > currentPrice && call.strike <= otmHigh)
          .sort((a, b) => a.strike - b.strike)
          .slice(0, 15); // Take only 15 closest OTM strikes
          
        for (const call of otmCalls) {
          const mid = midPrice(call) || 0.01;
          const iv = call.impliedVolatility || 0.25;
          const delta = calculateDelta(currentPrice, call.strike, timeToExpiry, riskFreeRate, iv, 'call', dividendYield);
          const bsProbs = calculateAssignmentProbability(currentPrice, call.strike, timeToExpiry, riskFreeRate, iv, null, dividendYield);

          // Model-free probability via digital approximation
          const idx = callsSorted.findIndex(c => Math.abs(c.strike - call.strike) < 1e-9);
          const digitalProb = estimateRiskNeutralProbFromCalls(callsSorted, idx, riskFreeRate, timeToExpiry);
          let baseProb = (digitalProb != null) ? digitalProb : bsProbs.enhanced;

          // Early assignment risk if ex-div before expiration
          if (divInfo.exDividendDate && divInfo.exDividendDate.getTime() > Date.now() && divInfo.exDividendDate.getTime() < expDate.getTime()) {
            const T_ex = (divInfo.exDividendDate.getTime() - Date.now()) / (1000 * 3600 * 24 * 365);
            const bsAtEx = calculateAssignmentProbability(currentPrice, call.strike, T_ex, riskFreeRate, iv, null, dividendYield);
            const expectedDividend = divInfo.dividendRateAnnual ? (divInfo.dividendRateAnnual / 4) : 0;
            const pEarly = estimateEarlyAssignmentProbabilityCall(currentPrice, call.strike, timeToExpiry, T_ex, riskFreeRate, expectedDividend, mid, bsAtEx.enhanced);
            baseProb = pEarly + (1 - pEarly) * baseProb;
          }

          // Get RF prediction
          const features = [
            currentPrice / call.strike, // moneyness
            daysToExpiry,
            iv,
            delta,
            (call.strike - currentPrice) / currentPrice, // otm percent
            (call.volume || 0) / 1_000_000, // volume in millions
            baseProb
          ];
          
          let rfProb = baseProb;
          try {
            rfProb = Math.max(0, Math.min(1, model.predict([features])[0]));
          } catch (e) {
            console.warn(`RF prediction failed, using BS: ${e.message}`);
          }
          
          // Blended probability: RF + BS with market adjustments
          let blendedProb = (rfProb * 0.7) + (baseProb * 0.3); // 70% RF, 30% base prob
          
          // Add market adjustments
          const borrowFee = 0.0; // Default to 0 for now
          blendedProb += 0.01 * (borrowFee / 10.0);
          
          const sentiment = 0.0; // Default to 0 for now  
          blendedProb += 0.02 * sentiment;
          
          // Ensure probability stays within bounds
          blendedProb = Math.max(0, Math.min(1, blendedProb));
          
          const otmFrac = (call.strike - currentPrice) / currentPrice;
          const returnPct = (mid / currentPrice) * 100;
          
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Export for Vercel
module.exports = app;
