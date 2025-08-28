<template>
  <div class="chart-container">
    <h3>Return vs Risk Analysis</h3>
    <p class="chart-subtitle">Bubble size = Volume | Color = Days to Expiry</p>
    <Bubble :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Bubble } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
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
    const data = exp.calls?.map(call => {
      const returnPct = parseFloat(call.returnPercent) || 0
      const assignmentProb = parseFloat(call.assignmentProbability) || 0
      const volume = call.volume || 0
      
      return {
        x: assignmentProb, // Risk (assignment probability)
        y: returnPct, // Return percentage
        r: Math.max(3, Math.min(20, Math.sqrt(volume / 100))) // Bubble size based on volume
      }
    }).filter(point => point.x > 0 || point.y > 0) || []

    const expDate = new Date(exp.expiration * 1000)
    const dte = Math.round((exp.expiration * 1000 - Date.now()) / (1000 * 3600 * 24))

    return {
      label: `${expDate.toLocaleDateString()} (${dte} DTE)`,
      data: data,
      backgroundColor: colors[index % colors.length],
      borderColor: colors[index % colors.length].replace('0.6', '1'),
      borderWidth: 1
    }
  }).filter(dataset => dataset.data.length > 0)

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
      text: 'Return vs Assignment Risk Analysis'
    },
    tooltip: {
      callbacks: {
        label: function(context) {
          const dataset = context.dataset
          const dataPoint = dataset.data[context.dataIndex]
          return [
            `${dataset.label}`,
            `Return: ${dataPoint.y.toFixed(3)}%`,
            `Assignment Risk: ${dataPoint.x.toFixed(1)}%`,
            `Volume: ${Math.round(Math.pow(dataPoint.r, 2) * 100)}`
          ]
        }
      }
    }
  },
  scales: {
    x: {
      display: true,
      title: {
        display: true,
        text: 'Assignment Probability (%) - Risk →'
      },
      min: 0
    },
    y: {
      display: true,
      title: {
        display: true,
        text: 'Return Percentage (%) - Reward →'
      },
      min: 0
    }
  },
  elements: {
    point: {
      hoverRadius: 8
    }
  }
}))
</script>

<style scoped>
.chart-container {
  width: 100%;
  height: 500px;
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