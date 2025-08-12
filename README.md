# Stock Options Analyzer

A full-stack web application for analyzing call options with advanced algorithms to help make better trading decisions.

## Features

- **Real-time Stock Quotes** - Live price data from Stooq
- **Options Chain Analysis** - Weekly and bi-weekly call options
- **Advanced Algorithms** - Assignment probability using Black-Scholes model
- **Goal-Based Scoring** - Targets 0.25% weekly or 0.5% bi-weekly returns
- **Risk Analysis** - Return/assignment ratio calculations
- **Smart Filtering** - Shows OTM options up to 10% above current price

## Live Demo

🚀 **[View Live App](https://your-app-name.vercel.app)** (Will be available after deployment)

## Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/stock-options-analyzer.git
   cd stock-options-analyzer
   ```

2. **Install dependencies**
   ```bash
   npm run install:all
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Access the app**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

## Tech Stack

- **Frontend**: Vue 3 + Vite
- **Backend**: Node.js + Express
- **APIs**: Yahoo Finance, Stooq
- **Deployment**: Vercel
- **Algorithms**: Black-Scholes option pricing model

## API Endpoints

- `GET /api/quote/:symbol` - Get stock quote
- `GET /api/options-weeks/:symbol` - Get weekly options data with analysis

## Trading Algorithm

The app uses a sophisticated algorithm that:
1. Calculates assignment probability using Black-Scholes model
2. Filters options based on return targets (0.25% weekly, 0.5% bi-weekly)
3. Scores options by return/risk ratio
4. Highlights the best option for your trading goals

## Deployment

This app is configured for one-click deployment to Vercel:

1. Push to GitHub
2. Connect your repo to Vercel
3. Deploy automatically

## License

MIT License - feel free to use for your own trading analysis!

## Disclaimer

This tool is for educational purposes only. Options trading involves risk. Always do your own research and consider consulting with a financial advisor.