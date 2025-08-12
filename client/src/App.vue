<script setup>
import { ref, computed } from 'vue'

const symbol = ref('AAPL')
const loading = ref(false)
const error = ref('')
const quote = ref(null)
const options = ref(null)
const weeklyOptions = ref(null)
const logs = ref([])

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString()
  logs.value.push(`[${timestamp}] ${message}`)
  if (logs.value.length > 20) logs.value.shift() // Keep only last 20 logs
}

async function fetchData() {
  error.value = ''
  loading.value = true
  quote.value = null
  options.value = null
  weeklyOptions.value = null
  const sym = symbol.value.trim()
  
  addLog(`Starting fetch for symbol: ${sym}`)
  
  if (!sym) {
    error.value = 'Enter a symbol'
    loading.value = false
    addLog('Error: No symbol entered')
    return
  }
  
  try {
    addLog('Making requests to /api/quote and /api/options-weeks')
    const [qRes, woRes] = await Promise.all([
      fetch(`/api/quote/${encodeURIComponent(sym)}`),
      fetch(`/api/options-weeks/${encodeURIComponent(sym)}`),
    ])
    
    addLog(`Quote response status: ${qRes.status}`)
    addLog(`Weekly options response status: ${woRes.status}`)
    
    if (!qRes.ok) {
      const qError = await qRes.text()
      addLog(`Quote error response: ${qError}`)
      throw new Error('Failed to load quote')
    }
    
    if (!woRes.ok) {
      const woError = await woRes.text()
      addLog(`Weekly options error response: ${woError}`)
      throw new Error('Failed to load weekly options')
    }
    
    quote.value = await qRes.json()
    weeklyOptions.value = await woRes.json()
    
    addLog(`Successfully loaded data. Weekly options count: ${weeklyOptions.value?.expirations?.length || 0}`)
  } catch (e) {
    error.value = e?.message || 'Request failed'
    addLog(`Error: ${e?.message || 'Request failed'}`)
  } finally {
    loading.value = false
    addLog('Fetch completed')
  }
}

const sortedCalls = computed(() => (options.value?.calls || []).slice().sort((a,b)=>a.strike-b.strike))
const sortedPuts = computed(() => (options.value?.puts || []).slice().sort((a,b)=>a.strike-b.strike))
</script>

<template>
  <div class="container">
    <h1>Stock + Options</h1>
    <form @submit.prevent="fetchData" class="form">
      <input v-model="symbol" placeholder="Ticker (e.g. AAPL)" />
      <button type="submit" :disabled="loading">{{ loading ? 'Loading…' : 'Fetch' }}</button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="quote" class="card">
      <h2>{{ quote.symbol }} — {{ quote.shortName }}</h2>
      <div class="grid">
        <div><strong>Price</strong><div>{{ quote.regularMarketPrice }} {{ quote.currency }}</div></div>
        <div><strong>Change</strong><div>{{ quote.regularMarketChange?.toFixed?.(2) }} ({{ (quote.regularMarketChangePercent*100 ? quote.regularMarketChangePercent : quote.regularMarketChangePercent)?.toFixed?.(2) }}%)</div></div>
        <div><strong>Exchange</strong><div>{{ quote.exchange }}</div></div>
        <div><strong>State</strong><div>{{ quote.marketState }}</div></div>
      </div>
    </section>

    <section v-if="weeklyOptions" class="card">
      <h2>Call Options (OTM up to 10%)</h2>
      <div class="otm-info">
        <p><strong>Current Price:</strong> ${{ weeklyOptions.currentPrice?.toFixed(2) }}</p>
        <p><strong>OTM Range:</strong> ${{ weeklyOptions.otmRange?.low?.toFixed(2) }} - ${{ weeklyOptions.otmRange?.high?.toFixed(2) }}</p>
      </div>
      <div v-for="(exp, index) in weeklyOptions.expirations" :key="exp.expiration" class="expiration-section">
        <h3>{{ index === 0 ? 'This Week' : 'Next Week' }} — {{ new Date(exp.expiration * 1000).toLocaleDateString() }}</h3>
        <div v-if="exp.bestOption" class="best-option-alert">
          🎯 <strong>Best Option:</strong> ${{ exp.bestOption.strike }} strike - ${{ exp.bestOption.premium }} premium 
          ({{ exp.bestOption.returnPercent }}% return) with {{ exp.bestOption.assignmentProbability }}% assignment probability
          <div class="explanation">{{ exp.bestOptionReason }}</div>
        </div>
        <div v-if="!exp.hasQualifyingOptions && exp.calls.length > 0" class="warning-alert">
          ⚠️ No options meet your 0.25% weekly or 0.5% bi-weekly return targets. Showing highest returns available.
        </div>
        <div v-if="exp.calls.length === 0" class="no-options">No call options in OTM range</div>
        <table v-else>
          <thead>
            <tr>
              <th>Strike</th><th>OTM %</th><th>Premium</th><th>Return %</th><th>Assignment %</th><th>Return/Risk</th><th>Score</th><th>Volume</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="call in exp.calls" :key="call.contractSymbol" 
                :class="{ 'best-option': exp.bestOption && call.contractSymbol === exp.bestOption.contractSymbol, 'meets-target': call.meetsTarget }">
              <td>${{ call.strike }}</td>
              <td>{{ call.otmPercent }}%</td>
              <td>${{ call.premium }}</td>
              <td>{{ call.returnPercent }}%</td>
              <td>{{ call.assignmentProbability }}%</td>
              <td>{{ call.returnAssignmentRatio }}</td>
              <td>{{ call.goalScore }}</td>
              <td>{{ call.volume || 0 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card debug-logs">
      <h3>Debug Logs</h3>
      <div class="logs">
        <div v-for="(log, index) in logs" :key="index" class="log-entry">{{ log }}</div>
        <div v-if="logs.length === 0" class="no-logs">No logs yet. Try fetching data.</div>
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
button { padding: 0.5rem 0.75rem; border: 1px solid #4f46e5; background: #4f46e5; color: white; border-radius: 6px; cursor: pointer; }
.error { color: #b91c1c; margin: 0.5rem 0; }
.card { border: 1px solid #eee; border-radius: 10px; padding: 1rem; margin-top: 1rem; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 0.5rem; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: right; padding: 0.35rem 0.5rem; border-bottom: 1px solid #f1f1f1; }
th:first-child, td:first-child { text-align: left; }
h1 { margin: 0 0 1rem; }
h2 { margin: 0.5rem 0 0.75rem; }
h3 { margin: 0.25rem 0 0.5rem; }
.otm-info { display: flex; gap: 2rem; margin-bottom: 1rem; flex-wrap: wrap; }
.otm-info p { margin: 0; }
.expiration-section { margin-bottom: 2rem; }
.expiration-section:last-child { margin-bottom: 0; }
.no-options { color: #666; font-style: italic; padding: 1rem; text-align: center; }
.best-option-alert { background: #f0f9ff; border: 2px solid #3b82f6; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; color: #1e40af; }
.explanation { font-size: 0.9rem; margin-top: 0.5rem; font-weight: normal; }
.warning-alert { background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; color: #92400e; }
.best-option { background: #fef3c7 !important; border-left: 4px solid #f59e0b; }
.meets-target { background: #f0fdf4; border-left: 2px solid #22c55e; }
.debug-logs { background: #f8f9fa; }
.logs { max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 0.8rem; }
.log-entry { padding: 0.2rem 0; border-bottom: 1px solid #eee; }
.log-entry:last-child { border-bottom: none; }
.no-logs { color: #666; font-style: italic; text-align: center; padding: 1rem; }
@media (max-width: 800px) { .grid {grid-template-columns: repeat(2,1fr);} .columns { grid-template-columns: 1fr; } .otm-info { gap: 1rem; } }
</style>
