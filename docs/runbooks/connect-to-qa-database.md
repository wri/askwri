# Connecting to the QA database (`askwri-db1`)

You'll need an SSO profile for AWS account **905418285725** (role `DataLabUser`).
Below, `<profile>` is whatever you named it.

## 1. Find your IP

```bash
curl https://checkip.amazonaws.com
```

Use this, not the console's "My IP" button. On a VPN or iCloud Private Relay your
browser has a different address than your terminal, and you'd allowlist the wrong one.

## 2. Allow it through the firewall

```bash
aws ec2 authorize-security-group-ingress --profile <profile> --region us-east-2 \
  --group-id sg-0575d778d3c2efb0c \
  --protocol tcp --port 5432 --cidr <your-ip>/32
```

Or in the console: Inbound rules -> Edit -> Add rule -> Type `PostgreSQL`,
Source `<your-ip>/32`, Description `<your name> <date>`.

https://us-east-2.console.aws.amazon.com/ec2/home?region=us-east-2#SecurityGroup:group-id=sg-0575d778d3c2efb0c

## 3. Get the certificate

```bash
curl -O https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

## 4. Get the password

```bash
export PGPASSWORD=$(aws ecs describe-task-definition --task-definition askwri-app-qa \
  --profile <profile> --region us-east-2 \
  --query "taskDefinition.containerDefinitions[].environment[?name=='DB_PASSWORD'].value | [] | [0]" \
  --output text)
```

## 5. Connect

Run from the folder holding `global-bundle.pem`:

```bash
uvx --with "psycopg[binary]" pgcli \
  "postgresql://askwri@askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com:5432/qa?sslmode=verify-full&sslrootcert=./global-bundle.pem&connect_timeout=5"
```

Nothing gets installed — `uvx` runs it temporarily. The `psycopg[binary]` part is
required because pgcli otherwise expects a system libpq.

## 6. Remove your rule when done

```bash
aws ec2 revoke-security-group-ingress --profile <profile> --region us-east-2 \
  --group-id sg-0575d778d3c2efb0c \
  --protocol tcp --port 5432 --cidr <your-ip>/32
```

## If it hangs, it's step 2

A hang means the firewall is dropping you; a bad password fails instantly.
Home IPs rotate, so re-run step 1 and re-add.
