<script setup>
import { ref, computed } from 'vue'

const symbol = ref('AAPL')
const loading = ref(false)
const error = ref('')
const rfAnalysis = ref(null)

function getExpirationLabel(expiration, daysToExpiry, isOptimal) {
  const date = new Date(expiration).toLocaleDateString()
  const optimal = isOptimal ? ' ⭐ OPTIMAL' : ''
  return `${daysToExpiry} DTE — ${date}${optimal}`
}

async function runRFAnalysis() {
  if (!symbol.value.trim()) {
    error.value = 'Enter a symbol first'
    return
  }
  
  loading.value = true
  error.value = ''
  rfAnalysis.value = null
  
  try {
    const response = await fetch(`/api/analyze-rf/${encodeURIComponent(symbol.value.trim())}`)
    
    if (!response.ok) {
      throw new Error('Failed to run RF analysis')
    }
    
    rfAnalysis.value = await response.json()
    
  } catch (e) {
    error.value = e?.message || 'RF analysis failed'
  } finally {
    loading.value = false
  }
}

</script>

<template>
  <div class="container">
    <h1>Tim's Options Analyzer - v{{ __COMMIT_COUNT__ }}</h1>
    <form @submit.prevent="runRFAnalysis" class="form">
      <input v-model="symbol" placeholder="Ticker (e.g. AAPL)" />
      <button type="submit" :disabled="loading">
        {{ loading ? 'Analyzing…' : '🤖 Analyze Options' }}
      </button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="rfAnalysis" class="card rf-analysis">
      <h2>🤖 Professional Covered Call Analysis for {{ rfAnalysis.symbol }}</h2>
      <div class="rf-stats">
        <div><strong>Current Price:</strong> ${{ rfAnalysis.currentPrice?.toFixed(2) }}</div>
        <div><strong>Strategy:</strong> 3 nearest expirations around {{ rfAnalysis.dteRange?.target }} DTE ({{ rfAnalysis.dteRange?.min }}-{{ rfAnalysis.dteRange?.max }} optimal)</div>
        <div><strong>IV Rank:</strong> 
          <span v-if="rfAnalysis.ivRankData && rfAnalysis.ivRankData.ivRank !== null">
            {{ rfAnalysis.ivRankData.ivRank?.toFixed(1) }}%
            <span :class="rfAnalysis.ivRankData.ivRank >= 50 ? 'iv-high' : 'iv-low'">
              ({{ rfAnalysis.ivRankData.ivRank >= 50 ? 'HIGH - Good for selling' : 'LOW - Poor premiums' }})
            </span>
          </span>
          <span v-else class="iv-unavailable">Not available</span>
        </div>
        <div><strong>Model Accuracy:</strong> R² = {{ rfAnalysis.modelStats?.r2?.toFixed(4) }}, MAE = {{ rfAnalysis.modelStats?.mae?.toFixed(4) }}</div>
        <div v-if="rfAnalysis.earningsDate"><strong>Next Earnings:</strong> {{ new Date(rfAnalysis.earningsDate).toLocaleDateString() }}</div>
      </div>
      <div class="probability-legend">
        <small><strong>Assignment %:</strong> Blended probability (70% RF + 30% Enhanced Black-Scholes) with market adjustments</small>
      </div>
      
      <div v-for="(week, index) in rfAnalysis.weeksData" :key="week.expiration" 
           class="rf-week-section" :class="{ 'optimal-dte': week.isOptimalDTE }">
        <h3>{{ getExpirationLabel(week.expiration, week.daysToExpiry, week.isOptimalDTE) }}</h3>
        
        <div v-if="week.earningsWarning" class="earnings-warning">
          ⚠️ <strong>Earnings Risk:</strong> Earnings expected {{ week.earningsWarning.daysToEarnings }} days before expiration 
          ({{ new Date(week.earningsWarning.earningsDate).toLocaleDateString() }}). High volatility risk!
        </div>
        
        <div v-if="week.bestOption" class="best-rf-alert">
          🎯 <strong>Best Option:</strong> ${{ week.bestOption.strike }} @ ${{ week.bestOption.premium }} 
          | {{ week.bestOption.returnPercent }}% return (~{{ week.bestOption.annualYield }}%/yr)
          | Assignment Risk: {{ week.bestOption.assignmentProbability }}%
          | OTM {{ week.bestOption.otmPercent }}%
        </div>
        
        <div v-if="week.options.length === 0" class="no-options">No qualifying RF options found</div>
        
        <table v-else class="rf-table">
          <thead>
            <tr>
              <th>Strike</th>
              <th>OTM %</th>
              <th>Premium</th>
              <th>Return %</th>
              <th>Annual Yield %</th>
              <th>Assignment %</th>
              <th>OI</th>
              <th>Volume</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="option in week.options" :key="option.strike" 
                :class="{ 'rf-best': week.bestOption && option.strike === week.bestOption.strike }">
              <td>${{ option.strike }}</td>
              <td>{{ option.otmPercent }}%</td>
              <td>${{ option.premium }}</td>
              <td>{{ option.returnPercent }}%</td>
              <td>{{ option.annualYield }}%</td>
              <td>{{ option.assignmentProbability }}%</td>
              <td>{{ option.openInterest?.toLocaleString() || 'N/A' }}</td>
              <td>{{ option.volume?.toLocaleString() || 0 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
  
</template>

<style scoped>
.container {
  max-width: 1000px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
input { flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 6px; }
button { padding: 0.5rem 0.75rem; border: 1px solid #059669; background: #059669; color: white; border-radius: 6px; cursor: pointer; }
.error { color: #b91c1c; margin: 0.5rem 0; }
.card { border: 1px solid #eee; border-radius: 10px; padding: 1rem; margin-top: 1rem; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: right; padding: 0.35rem 0.5rem; border-bottom: 1px solid #f1f1f1; }
th:first-child, td:first-child { text-align: left; }
h1 { margin: 0 0 1rem; }
h2 { margin: 0.5rem 0 0.75rem; }
h3 { margin: 0.25rem 0 0.5rem; }
.no-options { color: #666; font-style: italic; padding: 1rem; text-align: center; }
.rf-analysis { border-left: 4px solid #059669; }
.rf-stats { display: flex; gap: 2rem; margin-bottom: 1rem; flex-wrap: wrap; }
.rf-stats > div { margin: 0; }
.rf-week-section { margin-bottom: 2rem; }
.best-rf-alert { background: #ecfdf5; border: 2px solid #059669; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; color: #047857; }
.rf-table { margin-top: 1rem; }
.rf-best { background: #ecfdf5 !important; border-left: 4px solid #059669; }
.probability-legend { margin-bottom: 1rem; padding: 0.5rem; background: #f8fafc; border-radius: 4px; }
.earnings-warning { background: #fef2f2; border: 2px solid #ef4444; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; color: #dc2626; }
.iv-high { color: #059669; font-weight: bold; }
.iv-low { color: #dc2626; font-weight: bold; }
.iv-unavailable { color: #6b7280; font-style: italic; }
.optimal-dte { border-left: 4px solid #f59e0b; background: #fffbeb; }
.optimal-dte h3 { color: #d97706; }
</style>
