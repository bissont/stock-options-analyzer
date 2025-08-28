<template>
  <div class="chart-container">
    <h3>{{ expirationTitle }}</h3>
    <Line :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

const props = defineProps({
  expirationData: {
    type: Object,
    required: true
  },
  currentPrice: {
    type: Number,
    required: true
  }
})

const expirationTitle = computed(() => {
  const expDate = new Date(props.expirationData.expiration * 1000)
  const dte = Math.round((props.expirationData.expiration * 1000 - Date.now()) / (1000 * 3600 * 24))
  return `${expDate.toLocaleDateString()} (${dte} DTE)`
})

const sortedCalls = computed(() => {
  if (!props.expirationData.calls || props.expirationData.calls.length === 0) {
    return []
  }
  return [...props.expirationData.calls].sort((a, b) => a.strike - b.strike)
})

const chartData = computed(() => {
  if (sortedCalls.value.length === 0) {
    return { labels: [], datasets: [] }
  }

  // Prepare data points
  const strikes = []
  const annualYields = []
  const assignmentProbabilities = []

  sortedCalls.value.forEach(call => {
    strikes.push(`$${call.strike}`)
    
    // Get annual yield
    const annualYield = parseFloat(call.annualYield) || 0
    annualYields.push(annualYield)
    
    // Get NN Assignment probability
    const assignmentProb = parseFloat(call.assignmentProbability) || 0
    assignmentProbabilities.push(assignmentProb)
  })

  return {
    labels: strikes,
    datasets: [
      {
        label: 'NN Assignment %',
        data: assignmentProbabilities,
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.1)',
        borderWidth: 2,
        fill: false,
        yAxisID: 'y',
        tension: 0.1
      },
      {
        label: 'Annual Yield %',
        data: annualYields,
        borderColor: 'rgba(34, 197, 94, 1)',
        backgroundColor: 'rgba(34, 197, 94, 0.1)',
        borderWidth: 2,
        fill: false,
        yAxisID: 'y1',
        tension: 0.1
      }
    ]
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      position: 'top',
    },
    tooltip: {
      callbacks: {
        title: function(context) {
          // Show strike price in title
          const strikeLabel = context[0].label
          return `Strike: ${strikeLabel}`
        },
        label: function(context) {
          const label = context.dataset.label || ''
          const value = context.parsed.y.toFixed(2)
          const dataIndex = context.dataIndex
          const call = sortedCalls.value[dataIndex]
          
          let tooltip = `${label}: ${value}%`
          
          // Only show premium for the first dataset (NN Assignment %)
          if (context.datasetIndex === 0) {
            // Add premium information
            if (call?.mid) {
              tooltip += `\nPremium: $${call.mid}`
            } else if (call?.lastPrice) {
              tooltip += `\nLast Price: $${call.lastPrice}`
            }
          }
          
          return tooltip
        }
      }
    }
  },
  scales: {
    x: {
      display: true,
      title: {
        display: true,
        text: 'Strike Price'
      }
    },
    y: {
      type: 'linear',
      display: true,
      position: 'left',
      title: {
        display: true,
        text: 'NN Assignment Probability (%)',
        color: 'rgba(255, 99, 132, 1)'
      },
      ticks: {
        color: 'rgba(255, 99, 132, 1)'
      },
      grid: {
        drawOnChartArea: false,
      },
      min: 0,
      max: 100
    },
    y1: {
      type: 'linear',
      display: true,
      position: 'right',
      title: {
        display: true,
        text: 'Annual Yield (%)',
        color: 'rgba(34, 197, 94, 1)'
      },
      ticks: {
        color: 'rgba(34, 197, 94, 1)'
      },
      grid: {
        drawOnChartArea: true,
      },
      min: 0,
      max: 100
    },
  },
}))
</script>

<style scoped>
.chart-container {
  width: 100%;
  height: 400px;
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
}

h3 {
  margin: 0 0 1rem 0;
  color: #374151;
  text-align: center;
  font-size: 1.1rem;
}
</style>