<template>
  <div class="chart-container">
    <h3>Time Decay Analysis</h3>
    <p class="chart-subtitle">Assignment Probability vs Days to Expiry for Different Strike Ranges</p>
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
  optionsData: {
    type: Object,
    default: null
  }
})

const chartData = computed(() => {
  if (!props.optionsData?.expirations) {
    return { labels: [], datasets: [] }
  }

  const currentPrice = props.optionsData.currentPrice || 100

  // Define strike ranges for analysis
  const strikeRanges = [
    { name: '2-5% OTM', min: 1.02, max: 1.05, color: 'rgba(255, 99, 132, 1)' },
    { name: '5-10% OTM', min: 1.05, max: 1.10, color: 'rgba(54, 162, 235, 1)' },
    { name: '10-15% OTM', min: 1.10, max: 1.15, color: 'rgba(255, 205, 86, 1)' },
    { name: '15-20% OTM', min: 1.15, max: 1.20, color: 'rgba(75, 192, 192, 1)' }
  ]

  // Collect data points grouped by DTE
  const dteMap = new Map()

  props.optionsData.expirations.forEach(exp => {
    const dte = Math.round((exp.expiration * 1000 - Date.now()) / (1000 * 3600 * 24))
    if (!dteMap.has(dte)) {
      dteMap.set(dte, [])
    }
    
    exp.calls?.forEach(call => {
      const moneyness = call.strike / currentPrice
      const assignmentProb = parseFloat(call.assignmentProbability) || 0
      
      dteMap.get(dte).push({
        strike: call.strike,
        moneyness: moneyness,
        assignmentProbability: assignmentProb
      })
    })
  })

  // Sort DTEs
  const sortedDTEs = Array.from(dteMap.keys()).sort((a, b) => a - b)

  // Create datasets for each strike range
  const datasets = strikeRanges.map(range => {
    const data = sortedDTEs.map(dte => {
      const options = dteMap.get(dte).filter(opt => 
        opt.moneyness >= range.min && opt.moneyness < range.max
      )
      
      if (options.length === 0) return null
      
      // Calculate average assignment probability for this range and DTE
      const avgAssignmentProb = options.reduce((sum, opt) => sum + opt.assignmentProbability, 0) / options.length
      
      return {
        x: dte,
        y: avgAssignmentProb
      }
    }).filter(point => point !== null)

    return {
      label: range.name,
      data: data,
      borderColor: range.color,
      backgroundColor: range.color.replace('1)', '0.1)'),
      borderWidth: 2,
      fill: false,
      tension: 0.1
    }
  }).filter(dataset => dataset.data.length > 0)

  return {
    datasets
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'top',
    },
    title: {
      display: true,
      text: 'Time Decay: Assignment Probability Over Time'
    },
    tooltip: {
      callbacks: {
        label: function(context) {
          return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}% assignment probability at ${context.parsed.x} DTE`
        }
      }
    }
  },
  scales: {
    x: {
      type: 'linear',
      display: true,
      title: {
        display: true,
        text: 'Days to Expiry (DTE)'
      },
      reverse: true // Show time decay from right to left (more intuitive)
    },
    y: {
      display: true,
      title: {
        display: true,
        text: 'Average Assignment Probability (%)'
      },
      min: 0
    }
  },
  elements: {
    point: {
      radius: 4,
      hoverRadius: 6
    }
  }
}))
</script>

<style scoped>
.chart-container {
  width: 100%;
  height: 450px;
  margin: 2rem 0;
  padding: 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
}

h3 {
  margin: 0 0 0.5rem 0;
  color: #374151;
  text-align: center;
}

.chart-subtitle {
  margin: 0 0 1rem 0;
  color: #6b7280;
  font-size: 0.875rem;
  text-align: center;
  font-style: italic;
}
</style>