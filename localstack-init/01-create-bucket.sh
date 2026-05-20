#!/bin/bash
set -e

BUCKET_NAME="butterbase-app-storage"

echo "Checking if S3 bucket exists..."
if awslocal s3 ls "s3://${BUCKET_NAME}" 2>/dev/null; then
  echo "S3 bucket already exists, skipping creation"
else
  echo "Creating S3 bucket..."
  awslocal s3 mb "s3://${BUCKET_NAME}"
fi

echo "Configuring bucket versioning..."
awslocal s3api put-bucket-versioning --bucket "${BUCKET_NAME}" --versioning-configuration Status=Enabled

echo "Configuring CORS..."
awslocal s3api put-bucket-cors --bucket "${BUCKET_NAME}" --cors-configuration '{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-meta-x-butterbase-app-id", "x-amz-meta-x-butterbase-user-id"],
      "MaxAgeSeconds": 3600
    }
  ]
}'

echo "S3 bucket configured successfully"
