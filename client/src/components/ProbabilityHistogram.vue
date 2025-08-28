<template>
  <div class="chart-container">
    <h3>Assignment Probability Distribution</h3>
    <Bar :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
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

  // Collect all assignment probabilities
  const allProbabilities = []
  props.optionsData.expirations.forEach(exp => {
    exp.calls?.forEach(call => {
      const prob = parseFloat(call.assignmentProbability) || 0
      if (prob > 0) allProbabilities.push(prob)
    })
  })

  if (allProbabilities.length === 0) {
    return { labels: [], datasets: [] }
  }

  // Create bins for histogram (0-5%, 5-10%, 10-15%, etc.)
  const binSize = 5
  const maxProb = Math.ceil(Math.max(...allProbabilities) / binSize) * binSize
  const bins = []
  const binCounts = []
  const binLabels = []

  for (let i = 0; i <= maxProb; i += binSize) {
    bins.push(i)
    binLabels.push(`${i}-${i + binSize}%`)
    binCounts.push(0)
  }

  // Count probabilities in each bin
  allProbabilities.forEach(prob => {
    const binIndex = Math.floor(prob / binSize)
    if (binIndex < binCounts.length) {
      binCounts[binIndex]++
    }
  })

  return {
    labels: binLabels,
    datasets: [{
      label: 'Number of Options',
      data: binCounts,
      backgroundColor: 'rgba(75, 192, 192, 0.6)',
      borderColor: 'rgba(75, 192, 192, 1)',
      borderWidth: 1
    }]
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
      text: 'Distribution of Assignment Probabilities'
    },
    tooltip: {
      callbacks: {
        label: function(context) {
          const total = context.dataset.data.reduce((a, b) => a + b, 0)
          const percentage = ((context.parsed.y / total) * 100).toFixed(1)
          return `Count: ${context.parsed.y} (${percentage}% of options)`
        }
      }
    }
  },
  scales: {
    x: {
      display: true,
      title: {
        display: true,
        text: 'Assignment Probability Range (%)'
      }
    },
    y: {
      display: true,
      title: {
        display: true,
        text: 'Number of Options'
      },
      beginAtZero: true
    }
  }
}))
</script>

<style scoped>
.chart-container {
  width: 100%;
  height: 400px;
  margin: 2rem 0;
  padding: 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
}

h3 {
  margin: 0 0 1rem 0;
  color: #374151;
  text-align: center;
}
</style>