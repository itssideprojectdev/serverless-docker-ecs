import fs from 'fs';
import path from 'path';
import {S3Client, GetObjectCommand, ListObjectsV2Command} from '@aws-sdk/client-s3';
import {spawn} from 'child_process';

const s3Client = new S3Client({
  region: 'us-west-2',
});

let currentProcess: any = null;
const canaryFileName = 'canary.txt';
let currentCanaryContent = '';

async function checkCanaryFile(bucketName: string): Promise<boolean> {
  try {
    const getParams = {
      Bucket: bucketName,
      Key: canaryFileName,
    };

    const {Body} = await s3Client.send(new GetObjectCommand(getParams));
    if (Body) {
      const content = await Body.transformToString();
      if (content !== currentCanaryContent) {
        currentCanaryContent = content;
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking canary file:', error);
    return false;
  }
}

async function checkForUpdates() {
  try {
    let bucketName = 'memoizer' + '-hot-reload';

    const canaryChanged = await checkCanaryFile(bucketName);

    if (canaryChanged) {
      const listParams = {
        Bucket: bucketName,
      };

      const listResult = await s3Client.send(new ListObjectsV2Command(listParams));

      if (listResult.Contents) {
        for (const file of listResult.Contents) {
          const getParams = {
            Bucket: bucketName,
            Key: file.Key,
          };

          const {Body} = await s3Client.send(new GetObjectCommand(getParams));
          if (Body) {
            const content = await Body.transformToString();
            const localPath = path.join(process.cwd(), file.Key!);
            fs.mkdirSync(path.dirname(localPath), {recursive: true});
            fs.writeFileSync(localPath, content);
          }
        }
      }

      console.log('Files updated from S3');

      if (currentProcess) {
        console.log('Stopping current process');
        currentProcess.kill();
      }

      console.log('Starting new process');
      currentProcess = spawn('pnpm', ['start'], {stdio: 'inherit'});

      currentProcess.on('exit', (code: number) => {
        console.log(`Child process exited with code ${code}`);
      });
    } else {
      console.log('No updates found');
    }
  } catch (error) {
    console.error('Error updating files:', error);
  }
}

// Initial check
checkForUpdates();

// Check every 60 seconds
setInterval(checkForUpdates, 60000);
