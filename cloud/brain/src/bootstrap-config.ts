import { parseConfigArgFromArgv, setCloudConfigPath } from "@piclaw-cloud/shared/cloud-config";

const configPath = parseConfigArgFromArgv(process.argv);
if (configPath) setCloudConfigPath(configPath);
