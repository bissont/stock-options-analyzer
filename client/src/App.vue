<script setup>
import { ref } from 'vue'
import OptionsChart from './components/OptionsChart.vue'

const symbol = ref('AAPL')
const loading = ref(false)
const error = ref('')
const optionsData = ref(null)

async function fetchAllOptions() {
  if (!symbol.value.trim()) {
    error.value = 'Enter a ticker symbol first'
    return
  }
  
  loading.value = true
  error.value = ''
  optionsData.value = null
  
  try {
    const response = await fetch(`/api/all-options/${encodeURIComponent(symbol.value.trim().toUpperCase())}`)
    
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to fetch options data')
    }
    
    optionsData.value = await response.json()
    
  } catch (e) {
    error.value = e?.message || 'Failed to fetch options data'
  } finally {
    loading.value = false
  }
}

</script>

<template>
  <div class="container">
    <h1>Options Pricing Data</h1>
    <!-- Rollback to working chart layout -->
    
    <form @submit.prevent="fetchAllOptions" class="form">
      <input 
        v-model="symbol" 
        placeholder="Enter ticker symbol (e.g. AAPL)" 
        class="ticker-input"
      />
      <button type="submit" :disabled="loading" class="fetch-button">
        {{ loading ? 'Fetching...' : 'Get All Options' }}
      </button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="optionsData" class="options-data">
      <div class="stock-info">
        <h2>{{ optionsData.symbol }} - ${{ optionsData.currentPrice?.toFixed(2) }}</h2>
        <p>All available options for all strikes and expiration dates</p>
      </div>

      <div v-for="expiration in optionsData.expirations" :key="expiration.expiration" class="expiration-section">
        <h3>
          Expires {{ new Date(expiration.expiration * 1000).toLocaleDateString() }} 
          ({{ Math.round((expiration.expiration * 1000 - Date.now()) / (1000 * 3600 * 24)) }} DTE)
        </h3>
        
        <div class="calls-section">
          <h4>Call Options ({{ expiration.calls?.length || 0 }})</h4>
          <div v-if="expiration.calls?.length" class="options-table-container">
            <table class="options-table">
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>Last</th>
                  <th>OTM %</th>
                  <th>Return %</th>
                  <th>Annual Yield</th>
                  <th>NN Assign %</th>
                  <th>Volume</th>
                  <th>OI</th>
                  <th>IV</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="call in expiration.calls" :key="call.contractSymbol">
                  <td>${{ call.strike }}</td>
                  <td>${{ call.last || '--' }}</td>
                  <td>{{ call.otmPercent || '--' }}%</td>
                  <td>{{ call.returnPercent || '--' }}%</td>
                  <td>{{ call.annualYield || '--' }}%</td>
                  <td>{{ call.assignmentProbability || '--' }}%</td>
                  <td>{{ call.volume?.toLocaleString() || 0 }}</td>
                  <td>{{ call.openInterest?.toLocaleString() || 0 }}</td>
                  <td>{{ (call.impliedVolatility * 100)?.toFixed(1) || '--' }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="no-data">No call options available</div>
        </div>
      </div>

      <!-- Charts Section -->
      <div class="charts-section">
        <OptionsChart 
          v-for="expiration in optionsData.expirations" 
          :key="expiration.expiration"
          :expirationData="expiration"
          :currentPrice="optionsData.currentPrice"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.container {
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1rem;
}

.form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 2rem;
  align-items: center;
}

.ticker-input {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 2px solid #ddd;
  border-radius: 8px;
  font-size: 1rem;
  text-transform: uppercase;
}

.ticker-input:focus {
  outline: none;
  border-color: #059669;
}

.fetch-button {
  padding: 0.75rem 1.5rem;
  border: none;
  background: #059669;
  color: white;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 600;
}

.fetch-button:hover:not(:disabled) {
  background: #047857;
}

.fetch-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error {
  color: #dc2626;
  background: #fef2f2;
  padding: 0.75rem;
  border-radius: 6px;
  margin: 1rem 0;
}

.stock-info {
  text-align: center;
  margin-bottom: 2rem;
  padding: 1rem;
  background: #f8fafc;
  border-radius: 8px;
}

.stock-info h2 {
  margin: 0 0 0.5rem 0;
  color: #1f2937;
}

.stock-info p {
  margin: 0;
  color: #6b7280;
}

.expiration-section {
  margin-bottom: 3rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

.expiration-section h3 {
  background: #f9fafb;
  margin: 0;
  padding: 1rem;
  border-bottom: 1px solid #e5e7eb;
  color: #374151;
}

.calls-section {
  width: 100%;
}

.calls-section h4 {
  margin: 0;
  padding: 0.75rem 1rem;
  background: #ecfdf5;
  color: #047857;
  font-weight: 600;
}

.options-table-container {
  max-height: 400px;
  overflow-y: auto;
}

.options-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.options-table th {
  background: #f9fafb;
  padding: 0.5rem;
  text-align: right;
  border-bottom: 1px solid #e5e7eb;
  font-weight: 600;
  position: sticky;
  top: 0;
}

.options-table th:first-child {
  text-align: left;
}

.options-table td {
  padding: 0.5rem;
  text-align: right;
  border-bottom: 1px solid #f3f4f6;
}

.options-table td:first-child {
  text-align: left;
  font-weight: 600;
}

.options-table tbody tr:hover {
  background: #f9fafb;
}

.no-data {
  padding: 2rem;
  text-align: center;
  color: #6b7280;
  font-style: italic;
}

h1 {
  text-align: center;
  color: #1f2937;
  margin-bottom: 1rem;
}

.charts-section {
  margin: 2rem 0;
}

@media (max-width: 768px) {
  .options-table-container {
    max-height: none;
  }
}
</style>
