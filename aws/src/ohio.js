const AWS = require('aws-sdk');
const fs = require('fs');
const { promisify } = require('util');
require('dotenv/config');

AWS.config = new AWS.Config({
  region: 'us-east-2',
  accessKeyId: process.env.AWS_ACESSKEY,
  secretAccessKey: process.env.AWS_SECRETACCESSKEY,
});

const instanceRules = {
  BlockDeviceMappings: [
    {
      DeviceName: '/dev/sda1',
      Ebs: {
        VolumeSize: 8,
      },
    },
  ],
  ImageId: 'ami-0d5d9d301c853a04a',
  InstanceType: 't2.micro',
  MaxCount: 1,
  MinCount: 1,
};
const data = {
  mongo: `#!/bin/bash
apt update -y
apt install -y apt-transport-https ca-certificates curl gnupg-agent software-properties-common
curl -fsSl https://raw.githubusercontent.com/Fogelman/hybrid-cloud/master/aws/scripts/mongo.sh -o /home/ubuntu/mongo.sh
chmod +x /home/ubuntu/mongo.sh
/home/ubuntu/mongo.sh
`,
};

const createSecurityGroup = async (ec2, GroupName) => {
  return await ec2
    .createSecurityGroup({
      Description: 'Security Group gerado automaticamente',
      GroupName,
    })
    .promise()
    .then(({ GroupId }) => {
      return GroupId;
    });
};

const authorizeSecurityGroupIngress = async (ec2, GroupId) => {
  await ec2
    .authorizeSecurityGroupIngress({
      GroupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
        },

        {
          IpProtocol: 'tcp',
          FromPort: 27017,
          ToPort: 27017,
          UserIdGroupPairs: [
            {
              Description: 'acesso somente ao grupo',
              GroupId,
            },
          ],
        },
      ],
    })
    .promise();
};

const authorizeExternalIP = async (GroupId, ip) => {
  const ec2 = await new AWS.EC2({
    apiVersion: '2016-11-15',
    region: 'us-east-2',
  });
  await ec2
    .authorizeSecurityGroupIngress({
      GroupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 3333,
          ToPort: 3333,
          IpRanges: [{ CidrIp: ip + '/32' }],
        },
      ],
    })
    .promise();
};

const run = async () => {
  const ec2 = await new AWS.EC2({
    apiVersion: '2016-11-15',
    region: 'us-east-2',
  });

  const groupId = await createSecurityGroup(ec2, process.env.AWS_SECURITYGROUP);

  await authorizeSecurityGroupIngress(ec2, groupId);

  await ec2
    .createKeyPair({ KeyName: process.env.AWS_KEYNAME })
    .promise()
    .then(async ({ KeyMaterial: data }) => {
      await promisify(fs.writeFile)('aws-key-ohio.pem', data);
    });

  const { InstanceId: mongoId, PrivateIpAddress: ip } = await ec2
    .runInstances({
      ...instanceRules,
      KeyName: process.env.AWS_KEYNAME,
      SecurityGroups: [process.env.AWS_SECURITYGROUP],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            {
              Key: 'Name',
              Value: process.env.AWS_PROJECTNAME,
            },
            {
              Key: 'Service',
              Value: 'mongo',
            },
          ],
        },
      ],
      UserData: Buffer.from(data.mongo).toString('base64'),
      DryRun: false,
    })
    .promise()
    .then(({ Instances }) => {
      return Instances[0];
    });

  await ec2
    .waitFor('instanceStatusOk', {
      InstanceIds: [mongoId],
    })
    .promise()
    .catch(err => {
      console.error(err, err.stack);
    });

  const app = `#!/bin/bash
apt update -y
curl -sL https://deb.nodesource.com/setup_11.x | sudo -E bash -
apt install -y nodejs
npm install -g pm2
pm2 startup
git clone --depth=1 --no-tags https://github.com/Fogelman/hybrid-cloud.git /home/ubuntu/hybrid-cloud
npm i npm install --prefix /home/ubuntu/hybrid-cloud/app
echo "MONGO_URI=\"mongodb://${ip}/admin\"" >> /home/ubuntu/hybrid-cloud/app/.env
pm2 start /home/ubuntu/hybrid-cloud/app/src/index.js --name "app"
pm2 save
`;

  const { InstanceId: appId } = await ec2
    .runInstances({
      ...instanceRules,
      KeyName: process.env.AWS_KEYNAME,
      SecurityGroups: [process.env.AWS_SECURITYGROUP],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            {
              Key: 'Name',
              Value: process.env.AWS_PROJECTNAME,
            },
          ],
        },
      ],
      UserData: Buffer.from(app).toString('base64'),
      DryRun: false,
    })
    .promise()
    .then(({ Instances }) => {
      return Instances[0];
    });

  await ec2
    .waitFor('instanceStatusOk', {
      InstanceIds: [appId],
    })
    .promise()
    .catch(err => {
      console.error(err, err.stack);
    });

  const apiIp = await ec2
    .describeInstances({
      InstanceIds: [appId],
    })
    .promise()
    .then(({ Reservations }) => {
      return Reservations[0].Instances[0].PublicIpAddress;
    });

  return { ip: apiIp, groupId };
};

module.exports.run = run;
module.exports.authorize = authorizeExternalIP;
