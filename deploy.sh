#!/bin/bash

set -e

echo "🚀 Starting deployment..."

# Check if required tools are installed
command -v bun >/dev/null 2>&1 || { echo "❌ Bun is required but not installed. Aborting." >&2; exit 1; }
command -v terraform >/dev/null 2>&1 || { echo "❌ Terraform is required but not installed. Aborting." >&2; exit 1; }

# Build the project
echo "📦 Building the project..."
bun install
bun run build

# Create deployment package
echo "📦 Creating deployment package..."
zip -r function.zip dist/ node_modules/ package.json

# Deploy infrastructure
echo "🏗️ Deploying infrastructure..."
cd terraform
terraform init
terraform plan
terraform apply -auto-approve

# Update Lambda function code
echo "🔄 Updating Lambda function code..."
cd ..
FUNCTION_NAME=$(terraform -chdir=terraform output -raw lambda_function_name)
aws lambda update-function-code \
  --function-name $FUNCTION_NAME \
  --zip-file fileb://function.zip

echo "✅ Deployment completed successfully!"