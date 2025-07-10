terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
  default     = "cetus"
}

variable "source_bucket_name" {
  description = "Source S3 bucket name"
  type        = string
}

variable "optimized_bucket_name" {
  description = "Optimized S3 bucket name"
  type        = string
}

resource "aws_s3_bucket" "source" {
  bucket = var.source_bucket_name
  
  tags = {
    Name = "${var.project_name}-source"
    Type = "source"
  }
  
  lifecycle {
    prevent_destroy = true  # Prevent accidental deletion
  }
}

resource "aws_s3_bucket" "optimized" {
  bucket = var.optimized_bucket_name
  
  tags = {
    Name = "${var.project_name}-optimized"
    Type = "optimized"
  }
  
  lifecycle {
    prevent_destroy = true  # Prevent accidental deletion
  }
}

resource "aws_s3_bucket_policy" "optimized_public_read" {
  bucket = aws_s3_bucket.optimized.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.optimized.arn}/*"
      }
    ]
  })
}

resource "aws_s3_bucket_public_access_block" "optimized" {
  bucket = aws_s3_bucket.optimized.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_iam_role" "lambda_role" {
  name = "${var.project_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "${var.project_name}-lambda-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = "${aws_s3_bucket.source.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = "${aws_s3_bucket.optimized.arn}/*"
      }
    ]
  })
}

resource "aws_lambda_function" "image_optimizer" {
  filename         = "function.zip"
  function_name    = "${var.project_name}-image-optimizer"
  role            = aws_iam_role.lambda_role.arn
  handler         = "dist/index.handler"
  runtime         = "nodejs18.x"
  timeout         = 180
  memory_size     = 512

  environment {
    variables = {
      OPTIMIZED_BUCKET_NAME = aws_s3_bucket.optimized.bucket
      AWS_REGION           = var.aws_region
    }
  }

  depends_on = [
    aws_iam_role_policy.lambda_policy,
    aws_cloudwatch_log_group.lambda_logs,
  ]
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${var.project_name}-image-optimizer"
  retention_in_days = 14
}

resource "aws_s3_bucket_notification" "source_notification" {
  bucket = aws_s3_bucket.source.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.image_optimizer.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = ""
    filter_suffix       = ""
  }

  depends_on = [aws_lambda_permission.s3_invoke]
}

resource "aws_lambda_permission" "s3_invoke" {
  statement_id  = "AllowExecutionFromS3Bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.image_optimizer.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.source.arn
}

output "source_bucket_name" {
  value = aws_s3_bucket.source.bucket
}

output "optimized_bucket_name" {
  value = aws_s3_bucket.optimized.bucket
}

output "lambda_function_name" {
  value = aws_lambda_function.image_optimizer.function_name
}

output "optimized_bucket_url" {
  value = "https://${aws_s3_bucket.optimized.bucket}.s3.amazonaws.com"
}