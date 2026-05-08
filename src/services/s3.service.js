const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3 = new AWS.S3({
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region:          process.env.AWS_REGION || 'us-east-1',
});

const BUCKET = process.env.S3_BUCKET || 'usg-uploads';

// Generate presigned URL for direct client upload
const getPresignedUploadUrl = async (userId, fileType = 'image/jpeg') => {
  if (process.env.NODE_ENV === 'development' && !process.env.AWS_ACCESS_KEY_ID) {
    return { url: null, key: `mock-${Date.now()}`, mock: true };
  }

  const ext = fileType.split('/')[1] || 'jpg';
  const key = `uploads/${userId}/${uuidv4()}.${ext}`;

  const url = await s3.getSignedUrlPromise('putObject', {
    Bucket:      BUCKET,
    Key:         key,
    ContentType: fileType,
    Expires:     300, // 5 minutes
    ACL:         'private',
  });

  return { url, key, publicUrl: `https://${BUCKET}.s3.amazonaws.com/${key}` };
};

// Delete a file
const deleteFile = async (key) => {
  await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
};

// Copy/move file (e.g., from temp to permanent)
const moveFile = async (sourceKey, destKey) => {
  await s3.copyObject({
    Bucket:     BUCKET,
    CopySource: `${BUCKET}/${sourceKey}`,
    Key:        destKey,
  }).promise();
  await deleteFile(sourceKey);
  return destKey;
};

module.exports = { getPresignedUploadUrl, deleteFile, moveFile };
