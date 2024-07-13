const {ECSClient, UpdateServiceCommand, ListTasksCommand, StopTaskCommand} = require('@aws-sdk/client-ecs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clusterName = 'your-cluster-name';
const serviceName = 'your-service-name';
const delayBetweenStops = 10000; // Delay in milliseconds (10 seconds)

const ecsClient = new ECSClient({region: 'your-region'});

const updateService = async () => {
  try {
    const updateServiceCommand = new UpdateServiceCommand({
      cluster: clusterName,
      service: serviceName,
      forceNewDeployment: true,
    });
    await ecsClient.send(updateServiceCommand);
    console.log('Service updated to force new deployment');
  } catch (error) {
    console.error('Error updating service:', error);
  }
};

const listTasks = async () => {
  try {
    const listTasksCommand = new ListTasksCommand({
      cluster: clusterName,
      serviceName: serviceName,
    });
    const response = await ecsClient.send(listTasksCommand);
    return response.taskArns || [];
  } catch (error) {
    console.error('Error listing tasks:', error);
    return [];
  }
};

const stopTask = async (taskArn) => {
  try {
    const stopTaskCommand = new StopTaskCommand({
      cluster: clusterName,
      task: taskArn,
    });
    await ecsClient.send(stopTaskCommand);
    console.log(`Stopped task: ${taskArn}`);
  } catch (error) {
    console.error(`Error stopping task ${taskArn}:`, error);
  }
};

const restartTasksRoundRobin = async () => {
  try {
    await updateService();
    const tasks = await listTasks();
    for (const taskArn of tasks) {
      await stopTask(taskArn);
      await sleep(delayBetweenStops);
    }
    console.log('All tasks restarted in round-robin style.');
  } catch (error) {
    console.error('Error restarting tasks:', error);
  }
};

restartTasksRoundRobin();
