<template>
  <div class="chart-container">
    <h3>Strike Price vs Assignment Probability</h3>
    <Scatter :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Scatter } from 'vue-chartjs'
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
    return { datasets: [] }
  }

  const colors = [
    'rgba(255, 99, 132, 0.6)',
    'rgba(54, 162, 235, 0.6)', 
    'rgba(255, 205, 86, 0.6)',
    'rgba(75, 192, 192, 0.6)',
    'rgba(153, 102, 255, 0.6)',
    'rgba(255, 159, 64, 0.6)'
  ]

  const datasets = props.optionsData.expirations.map((exp, index) => {
    const data = exp.calls?.map(call => ({
      x: call.strike,
      y: parseFloat(call.assignmentProbability) || 0
    })) || []

    const expDate = new Date(exp.expiration * 1000)
    const dte = Math.round((exp.expiration * 1000 - Date.now()) / (1000 * 3600 * 24))

    return {
      label: `${expDate.toLocaleDateString()} (${dte} DTE)`,
      data: data,
      backgroundColor: colors[index % colors.length],
      borderColor: colors[index % colors.length].replace('0.6', '1'),
      borderWidth: 1
    }
  })

  return { datasets }
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
      text: 'Options Strike Prices vs Assignment Probability'
    },
    tooltip: {
      callbacks: {
        label: function(context) {
          return `Strike: $${context.parsed.x}, Assignment: ${context.parsed.y}%`
        }
      }
    }
  },
  scales: {
    x: {
      display: true,
      title: {
        display: true,
        text: 'Strike Price ($)'
      }
    },
    y: {
      display: true,
      title: {
        display: true,
        text: 'Assignment Probability (%)'
      },
      min: 0,
      max: 100
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