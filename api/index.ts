import { VercelRequest, VercelResponse } from "@vercel/node";
import fastify, { FastifyRequest, FastifyReply } from "fastify";
import { createClient } from "@supabase/supabase-js";
import {
  ECSClient,
  RunTaskCommand,
  LaunchType,
  AssignPublicIp,
} from "@aws-sdk/client-ecs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { Readable } from "node:stream";

// Augment FastifyRequest to add 'user' property
declare module "fastify" {
  interface FastifyRequest {
    user?: any;
  }
}

const app = fastify({ logger: false });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);
const ecs = new ECSClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });

// CORS plugin
app.register(async function (fastify) {
  fastify.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  });

  fastify.options("/*", async (request, reply) => {
    return reply.send();
  });
});

// Auth middleware (skip for health check)
app.addHook(
  "preHandler",
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/" || request.method === "OPTIONS") {
      return;
    }

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
app.get("/", async () => ({
  status: "OK",
  timestamp: new Date().toISOString(),
}));

// Get all scripts for user
app.get("/scripts", async (request: FastifyRequest) => {
  const { data, error } = await supabase
    .from("scripts")
    .select("*")
    .eq("user_id", request.user?.id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
});

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

// Update script route
interface UpdateScriptBody {
  code: string;
  name: string;
}

interface UpdateScriptParams {
  id: string;
}

app.put<{ Body: UpdateScriptBody; Params: UpdateScriptParams }>(
  "/scripts/:id",
  async (
    request: FastifyRequest<{
      Body: UpdateScriptBody;
      Params: UpdateScriptParams;
    }>
  ) => {
    const { id } = request.params;
    const { code, name } = request.body;

    const { data, error } = await supabase
      .from("scripts")
      .update({ code, name, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", request.user?.id)
      .select();

    if (error) throw error;
    return data[0];
  }
);

// Delete script route
interface DeleteScriptParams {
  id: string;
}

app.delete<{ Params: DeleteScriptParams }>(
  "/scripts/:id",
  async (request: FastifyRequest<{ Params: DeleteScriptParams }>) => {
    const { id } = request.params;

    const { error } = await supabase
      .from("scripts")
      .delete()
      .eq("id", id)
      .eq("user_id", request.user?.id);

    if (error) throw error;
    return { success: true };
  }
);

// Interface for /run params
interface RunParams {
  scriptId: string;
}

// Run script route
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
      .eq("user_id", request.user?.id)
      .single();

    console.log("Running script:", scriptId, script);

    console.log("Environment variables:", {
      ECS_CLUSTER_NAME: process.env.ECS_CLUSTER_NAME,
      ECS_TASK_DEFINITION: process.env.ECS_TASK_DEFINITION,
      AWS_REGION: process.env.AWS_REGION,
      S3_BUCKET: process.env.S3_BUCKET,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ? "SET" : "NOT SET",
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY
        ? "SET"
        : "NOT SET",
    });

    if (!script) return reply.code(404).send({ error: "Script not found" });
    const outputKey = `runs/${crypto.randomUUID()}`;

    try {
      const params = {
        cluster: process.env.ECS_CLUSTER_NAME,
        taskDefinition: process.env.ECS_TASK_DEFINITION,
        launchType: LaunchType.FARGATE,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ["subnet-0dfaea79522b6d2a3", "subnet-004fb83565ba72e41"],
            securityGroups: ["sg-082f1a78f3d984d72"],
            assignPublicIp: AssignPublicIp.ENABLED,
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "playwright-task",
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
      console.error(err);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await app.ready();
  app.server.emit("request", req, res);
}
