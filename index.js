'use strict';

const AWS = require('aws-sdk');
const path = require("path");
const fs = require('fs');
const mime = require('mime-types')

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.commands = {
      syncToS3: {
        usage: 'Deploys the `app` directory to your bucket',
        lifecycleEvents: [
          'sync',
        ],
      },
      domainInfo: {
        usage: 'Fetches and prints out the deployed CloudFront domain names',
        lifecycleEvents: [
          'domainInfo',
        ],
      },
      invalidateCache: {
        usage: 'Invalidates CloudFront cache',
        lifecycleEvents: [
          'invalidateCache',
        ],
      },
    };

    this.hooks = {
      'syncToS3:sync': this.syncDirectory.bind(this),
      'domainInfo:domainInfo': this.domainInfo.bind(this),
      'invalidateCache:invalidateCache': this.invalidateCache.bind(this)
    };
  }

  async clearBucket(bucket, s3) {
    try {
      const listedObjects = await s3.listObjectsV2({Bucket: bucket}).promise()
      if (listedObjects.Contents.length === 0) return;

      const deleteParams = {
          Bucket: bucket,
          Delete: { Objects: [] }
      };
  
      listedObjects.Contents.forEach(({ Key }) => {
          deleteParams.Delete.Objects.push({ Key });
      });

      await s3.deleteObjects(deleteParams).promise();

      if (listedObjects.IsTruncated) await clearBucket(bucket, s3);
  
      this.serverless.cli.log(`Successfully cleaned ${bucket} bucket`)
    } catch (error) {
      console.log(error)
      this.serverless.cli.log(`Error in cleaning ${bucket} bucket`)
      throw new Error(`Error in cleaning ${bucket} bucket`);
    }
  }

  // syncs the `app` directory to the provided bucket
  async syncDirectory() {
    const s3Bucket = this.serverless.variables.service.custom.s3Bucket;
    const s3LocalPath = this.serverless.variables.service.custom.s3LocalPath;
    const s3 = new AWS.S3({credentials: new AWS.SharedIniFileCredentials({profile: this.serverless.variables.service.provider.profile})});

    function walkSync(currentDirPath, callback) {
        fs.readdirSync(currentDirPath).forEach((name) => {
            const filePath = path.join(currentDirPath, name);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                callback(filePath, stat);
            } else if (stat.isDirectory()) {
                walkSync(filePath, callback);
            }
        });
    }

    await this.clearBucket(s3Bucket, s3)

    walkSync(s3LocalPath, async (filePath, stat) => {
        let bucketPath = filePath.substring(s3LocalPath.length);
        
        let params = {
          Bucket: s3Bucket, 
          Key: bucketPath, 
          Body: fs.readFileSync(filePath),
          ContentType: mime.lookup(filePath),
        }

        try {
          await s3.putObject(params).promise();
          this.serverless.cli.log(`Successfully uploaded ${bucketPath} to s3 bucket`)
        } catch (error) {
          this.serverless.cli.log(`Error in uploading ${bucketPath} to s3 bucket`)
          throw new Error(`Error in uploading ${bucketPath} to s3 bucket`);
        }
    });
  };

  // fetches the domain name from the CloudFront outputs and prints it out
  async domainInfo() {
    try {
      const stackName = this.serverless.variables.service.service + '-' + this.options.stage

      const cloudformation = new AWS.CloudFormation({
        credentials: new AWS.SharedIniFileCredentials({profile: this.serverless.variables.service.provider.profile}),
        region: this.serverless.variables.service.provider.region
      });
      const data = await cloudformation.describeStacks({ StackName: stackName }).promise();

      const outputs = data.Stacks[0].Outputs;
      const output = outputs.find(
        entry => entry.OutputKey === 'WebAppCloudFrontDistributionOutput',
      );
      if (output && output.OutputValue) {
        this.serverless.cli.log(`Web App Domain: ${output.OutputValue}`);
        return output.OutputValue;
      }

      this.serverless.cli.log('Web App Domain: Not Found');
    } catch (error) {
      throw new Error('Could not extract Web App Domain');
    }
  }

  async invalidateCache() {
    try {
      const domain = await this.domainInfo();
      const cloudfront = new AWS.CloudFront({credentials: new AWS.SharedIniFileCredentials({profile: this.serverless.variables.service.provider.profile})});
      const data =  await cloudfront.listDistributions({}).promise();
      const distributions = data.DistributionList.Items;
      const distribution = distributions.find(
        entry => entry.DomainName === domain
      );
      if (distribution) {
        this.serverless.cli.log(
          `Invalidating CloudFront distribution with id: ${distribution.Id}`,
        );
        await cloudfront.createInvalidation({
          DistributionId: distribution.Id,
          InvalidationBatch: {
            CallerReference: new Date().getTime().toString(),
            Paths: {
                Items: [
                    "/*" 
                ], 
                Quantity: 1
            }
          }
        }).promise()
      } 
  } catch (error) {
      const message = `Failed invalidating CloudFront cache ${error}`;
      this.serverless.cli.log(message);
      throw new Error(`Failed invalidating CloudFront cache ${error}`);
    }
  }
}

module.exports = ServerlessPlugin;
