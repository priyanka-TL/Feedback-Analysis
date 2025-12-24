#!/bin/bash

# Quick Start Setup Script
# This script helps you get started quickly with the feedback analysis toolkit

set -e

echo "=================================="
echo "Feedback Analysis Toolkit Setup"
echo "=================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 14+ first."
    exit 1
fi

echo "✓ Node.js found: $(node --version)"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this from the test-scripts directory."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install
echo "✓ Dependencies installed"
echo ""

# Setup .env file
if [ ! -f ".env" ]; then
    echo "⚙️  Setting up .env file..."
    cp .env.example .env
    echo "✓ Created .env from template"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env and add your API keys!"
    echo "   Open .env and replace 'your_api_key_1' with your actual Gemini API key(s)"
    echo ""
else
    echo "✓ .env file already exists"
    echo ""
fi

# Check if questions-config.json exists
if [ ! -f "questions-config.json" ]; then
    echo "⚠️  questions-config.json not found."
    echo ""
    echo "You can either:"
    echo "  1. Copy the example: cp questions-config.example.json questions-config.json"
    echo "  2. Create your own based on the documentation (see README.md)"
    echo ""
else
    echo "✓ questions-config.json found"
    echo ""
fi

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p logs
mkdir -p debug
mkdir -p reports
echo "✓ Directories created"
echo ""

echo "=================================="
echo "Setup Complete! 🎉"
echo "=================================="
echo ""
echo "Next Steps:"
echo ""
echo "1. Edit .env file with your API keys:"
echo "   nano .env"
echo ""
echo "2. Create questions-config.json:"
echo "   cp questions-config.example.json questions-config.json"
echo "   # Then customize for your questions"
echo ""
echo "3. Prepare your CSV data file with question columns (Q1, Q2, etc.)"
echo ""
echo "4. Test with a small sample:"
echo "   node 3_categorize.js --help"
echo "   node 3_categorize.js --input your_data.csv --output test.csv"
echo ""
echo "5. Run the complete pipeline:"
echo "   node 0_pipeline.js --input data.csv --output final.csv"
echo ""
echo "📚 Documentation:"
echo "   - QUICKSTART.md - Get started in 5 minutes"
echo "   - README.md - Complete documentation"
echo "   - USAGE.md - Detailed workflows and examples"
echo ""
echo "Happy analyzing! 🚀"
