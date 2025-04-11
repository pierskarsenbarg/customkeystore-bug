# Repo for <https://github.com/pulumi/pulumi-aws/issues/5421>

Instructions for running this repo so you can test the fix for the above issue

## Summary

We're going to do the following:

- A VPC to run everything in
- Cloud HSM cluster
- The CSR from the cluster so that we can sign it
- One HSM so that we can initialise the cluster - we'll add another later on
- Private key, self-signed certificate that we'll use to sign the CSR from the cluster and generate a new cert
- Keypair to SSH into the EC2 instance
- Security group to allow us to SSH into the EC2 instance (and a rule to allow the instance to talk to the HSM cluster)
- EC2 instance

When the program ends, we'll be able to upload the self-signed certificate and the certificate we generated from the CSR via the AWS Console. We need to do this to initialise the HSM Cluster. Once that's complete, we will SSH into the EC2 instance, add the IP address of the HSM cluster copy the self-signed certificate there and create a password for the cluster.

Finally, we'll uncomment the last few lines of the Pulumi program, create another HSM (we need to have two in seperate subnets to create a custom key store) and the custom keystore resource. Hopefully that will fail with `v6.70.0` of the AWS provider, but will work with `v6.63.3`.

## Steps

1. Clone this repo
1. Create stack: `pulumi stack init dev`
1. Add public ssh keys to stack config: `cat ~/.ssh/id_rsa.pub | pulumi config set sshPubKey --secret --`
1. Add region to deploy this to: `pulumi config set aws:region eu-west-1`
1. Add IP address to config so we can SSH into the EC2 instance
1. Run `pulumi up` to completion. This will take a while. The HSM resources take about 350 seconds.
1. Login to the AWS Console and go to the URL in the `clusterUrl` stack output
1. Click on the "Initialise" button
1. Click the "Cluster CSR" button to download the CSR. We won't use it as we've already generated everything, but you can't proceed without downloading it.
1. Click "Next"
1. On the "Upload certificates" page, the "Cluster certificate" is in the dist folder and it's the one with the name ending `_CustomerHsmCertificate.crt`. The "Issuing certificate" is `customerCA.crt`. Upload these and click "Upload and initialise"
1. Once the initialisation is complete, you will see a banner at the top of the page asking you to set a password. SSH into the EC2 instance: `ssh -i ~/.ssh/id_rsa ec2-user@$(pulumi stack output ec2Ip)`
1. Using the `hsmIp` stack output, run the following command on the EC2 instance: `sudo /opt/cloudhsm/bin/configure-cli -a {ip address}` (where `{ip address}` is the value of the `hsmIp stack output`)
1. Run `sudo vim /opt/cloudhsm/etc/customerCA.crt` and copy and paste the value of the `customerCA.crt` file in the `dist` folder on your local machine
1. Save the file and exit vim
1. Run the following command: `/opt/cloudhsm/bin/cloudhsm-cli interactive`
1. If the certificate is correct and the security group is set up correctly, you should see the `aws-cloudhsm` prompt. Run `cluster activate` and set a random password. If this is successful you should see the following output:

```json
{
  "error_code": 0,
  "data": "Cluster activation successful"
}
```

1. Type `quit` and logout of the EC2 instance
1. Uncomment the last three resources and run `pulumi up`. Again, this will take a while because the `HSM` resources take about 350 seconds to be created.

If you're using the `6.70.0` version of the `@pulumi/aws` SDK then the `CustomKeyStore` resource should fail. If you've set it to be `6.66.3` then it will be successful. 

Well done! You have reproduced the issue. You can comment out and uncomment the `CustomKeyStore` resource to delete and create the resource to test the different versions.

Don't forget to run `pulumi destroy` at the end.
