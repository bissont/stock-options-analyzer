#!/bin/bash

echo "🚀 Deploying Stock Options Analyzer to GitHub..."

# Add all changes
git add .

# Commit with descriptive message
git commit -m "Fix: Restructure for Vercel deployment - move server to /api directory"

# Push to GitHub
git push origin main

echo "✅ Deployment pushed to GitHub!"
echo "🔗 Check your Vercel dashboard for the new build"