import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as random from "@pulumi/random";
import * as std from "@pulumi/std";
import * as tls from "@pulumi/tls";
import * as local from "@pulumi/local";
import * as cloudinit from "@pulumi/cloudinit";

const vpc = new awsx.ec2.Vpc("vpc", {
    cidrBlock: "10.0.0.0/16",
    numberOfAvailabilityZones: 2,
    subnetSpecs: [{
        type: awsx.ec2.SubnetType.Public,
        name: "public-ecs-subnet",
    }],
    subnetStrategy: "Auto",
    tags: {
        Name: "pk-hsm"
    },
    natGateways: {
        strategy: "None"
    },
});

const hsmCluster = new aws.cloudhsmv2.Cluster("hsmCluster", {
    hsmType: "hsm2m.medium",
    subnetIds: vpc.publicSubnetIds,
    mode: "FIPS"
})



const hsm = new aws.cloudhsmv2.Hsm("hsm", {
    subnetId: vpc.publicSubnetIds[0],
    clusterId: hsmCluster.clusterId,
})

export const hsmIp = hsm.ipAddress

const customerCAKey = new tls.PrivateKey("customerCAKey", {
    algorithm: "RSA"
})

const customerCACrt = new tls.SelfSignedCert("customerCACrt", {
    privateKeyPem: customerCAKey.privateKeyPem,
    validityPeriodHours: 3652 * 24,
    isCaCertificate: true,
    allowedUses: [
    ],
    subject: {
        commonName: "piers"
    }
})

const clusterCsr = aws.cloudhsmv2.getClusterOutput({
    clusterId: hsmCluster.clusterId,
}, {dependsOn: [hsm]}).clusterCertificates[0].clusterCsr;

const signedCrt = new tls.LocallySignedCert("signedCrt", {
    validityPeriodHours: 3652 * 24,
    allowedUses: [
    ],
    caPrivateKeyPem: customerCAKey.privateKeyPem,
    caCertPem: customerCACrt.certPem,
    isCaCertificate: true,
    certRequestPem: clusterCsr
}, {ignoreChanges: ["certRequestPem"], dependsOn: [hsm]});

const clusterCrtFile = new local.File("clusterCrtFile", {
    filename: pulumi.interpolate`./dist/${hsmCluster.clusterId}_CustomerHsmCertificate.crt`,
    content: signedCrt.certPem,
    filePermission: "644"
})

const customerCACrtFile = new local.File("customerCACrtFile", {
    filename: "./dist/customerCA.crt",
    content: customerCACrt.certPem,
    filePermission: "644"
})

const config = new pulumi.Config();
const sshKey = config.requireSecret("sshPubKey");

const keypair = new aws.ec2.KeyPair("pk-keypair", {
    keyName: "piers-keypair",
    publicKey: sshKey
})

const amiId = aws.ec2.getAmi({
    mostRecent: true,
    filters: [{
        name: "name",
        values: ["al2023-ami-2023.7.20250331.0-kernel-6.1-arm64"]
    }]
})

const myIp = config.require("myIp")

const sg = new aws.ec2.SecurityGroup("pk-ssh-sg", {
    vpcId: vpc.vpcId,
    egress: [{
        fromPort: 0,
        toPort: 65535,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"]
    }],
    ingress: [{
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: [pulumi.interpolate`${myIp}/32`]
    }]    
});

const hsmSg = aws.ec2.getSecurityGroupOutput({name: pulumi.interpolate`cloudhsm-${hsmCluster.clusterId}-sg`});

const hsmSgRule = new aws.vpc.SecurityGroupIngressRule("hsmSgRule", {
    securityGroupId: hsmSg.id,
    ipProtocol: "tcp",
    fromPort: 2223,
    toPort: 2224,
    referencedSecurityGroupId: sg.id,
    description: "sg to allow access from ec2 instance"
})

const serverConfig = new cloudinit.Config("userData", {
    base64Encode: true,
    parts: [{
        contentType: "text/cloud-config",
        content: std.fileOutput({input: "./userdata.yaml"}).result
    }],
})

const instance = new aws.ec2.Instance("sshbox-pk", {
    tags: {
        Name: "piers-ssh"
    },
    vpcSecurityGroupIds: [sg.id],
    ami: amiId.then(x => x.id),
    subnetId: vpc.publicSubnetIds[0],
    keyName: keypair.keyName,
    instanceType: aws.ec2.InstanceType.T4g_Small,
    associatePublicIpAddress: true,
    userData: serverConfig.rendered
});

const awsConfig = new pulumi.Config("aws");
const awsRegion = awsConfig.get("region")
export const ec2Ip = instance.publicIp
export const clusterUrl = pulumi.interpolate`https://${awsRegion}.console.aws.amazon.com/cloudhsm/home?region=${awsRegion}#/clusters/${hsmCluster.clusterId}/hsms`

// const hsm2 = new aws.cloudhsmv2.Hsm("hsm2", {
//     subnetId: vpc.publicSubnetIds[1],
//     clusterId: hsmCluster.clusterId
// })

// const pw = new random.RandomPassword("keystorePw", {
//     length: 32
// })

// const customKeyStore = new aws.kms.CustomKeyStore("customKeyStore", {
//     customKeyStoreName: "customkeystore",
//     cloudHsmClusterId: hsmCluster.clusterId,
//     keyStorePassword: pw.result,
//     trustAnchorCertificate: std.fileOutput({input: "./dist/customerCA.crt"}).result
// }, {dependsOn: [hsm, hsm2]})