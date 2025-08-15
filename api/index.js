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

// Export for Vercel
module.exports = app;