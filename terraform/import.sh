#!/bin/bash
echo "🔄 Importing existing S3 buckets into Terraform..."

# Initialize Terraform
terraform init

# Import existing buckets
echo "📦 Importing source bucket: $SOURCE_BUCKET"
terraform import aws_s3_bucket.source $SOURCE_BUCKET

echo "📦 Importing optimized bucket: $OPTIMIZED_BUCKET"
terraform import aws_s3_bucket.optimized $OPTIMIZED_BUCKET

echo "✅ Import completed!"
echo "🔄 Now run: terraform plan"