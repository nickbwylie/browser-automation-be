import fastify, { FastifyRequest, FastifyReply } from "fastify";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import {
  ECSClient,
  RunTaskCommand,
  LaunchType,
  AssignPublicIp,
} from "@aws-sdk/client-ecs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { Readable } from "node:stream";

dotenv.config();

// Augment FastifyRequest to add 'user' property
declare module "fastify" {
  interface FastifyRequest {
    user?: any; // Replace 'any' with your Supabase User type if available
  }
}

const app = fastify({ logger: true });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);
const ecs = new ECSClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });

// Auth middleware
app.addHook(
  "preHandler",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers.authorization?.split(" ")[1];
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) return reply.code(401).send({ error: "Invalid token" });
    request.user = user;
  }
);

// Health check route
app.get("/", async () => ({ status: "OK" }));

// Interface for /scripts body
interface CreateScriptBody {
  code: string;
  name: string;
}

// Create script route
app.post<{ Body: CreateScriptBody }>(
  "/scripts",
  async (request: FastifyRequest<{ Body: CreateScriptBody }>) => {
    const { code, name } = request.body;
    const { data, error } = await supabase
      .from("scripts")
      .insert({ user_id: request.user?.id, code, name })
      .select();
    if (error) throw error;
    return data[0];
  }
);

// Interface for /run params
interface RunParams {
  scriptId: string;
}

// Run script route (synchronous ECS call, no queue)
app.post<{ Params: RunParams }>(
  "/run/:scriptId",
  async (
    request: FastifyRequest<{ Params: RunParams }>,
    reply: FastifyReply
  ) => {
    const { scriptId } = request.params;
    const { data: script } = await supabase
      .from("scripts")
      .select("code")
      .eq("id", scriptId)
      .single();

    console.log("Running script:", scriptId, script);

    if (!script) return reply.code(404).send({ error: "Script not found" });
    const outputKey = `runs/${crypto.randomUUID()}`;

    try {
      const params = {
        cluster: process.env.ECS_CLUSTER_NAME,
        taskDefinition: process.env.ECS_TASK_DEFINITION,
        launchType: LaunchType.FARGATE,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ["subnet-0dfaea79522b6d2a3", "subnet-004fb83565ba72e41"], // Replace with actual subnet IDs from AWS Console
            securityGroups: ["sg-082f1a78f3d984d72"], // Replace with actual security group ID
            assignPublicIp: AssignPublicIp.ENABLED,
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "playwright-task", // Your container name from task definition
              environment: [
                { name: "SCRIPT_CODE", value: script.code },
                { name: "OUTPUT_KEY", value: outputKey },
                { name: "S3_BUCKET", value: process.env.S3_BUCKET! },
              ],
            },
          ],
        },
      };
      await ecs.send(new RunTaskCommand(params));
      return { status: "running", outputKey };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to start task" });
    }
  }
);

// Interface for /results params
interface ResultsParams {
  outputKey: string;
}

// Results route
app.get<{ Params: ResultsParams }>(
  "/results/:outputKey",
  async (request: FastifyRequest<{ Params: ResultsParams }>) => {
    const { outputKey } = request.params;
    try {
      const dataObj = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: `${outputKey}/data.json`,
        })
      );
      const logsObj = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: `${outputKey}/logs.txt`,
        })
      );
      const data = await streamToString(dataObj.Body as Readable);
      const logs = await streamToString(logsObj.Body as Readable);
      return { data: JSON.parse(data), logs };
    } catch (err) {
      return { error: "Results not found or error fetching" };
    }
  }
);

// Helper function for S3 streams
async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Start the server
app.listen({ port: 3000 }, (err) => {
  if (err) console.error(err);
  console.log("Server running on port 3000");
});
