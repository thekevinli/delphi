import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PlanStore } from '../main/research/store.ts';
import { startMcpSocket, pairPlans } from '../main/research/mcp.ts';
import { LocalPlans } from '../main/research/plans.ts';
import { installLauncher } from '../main/research/launcher.ts';
const directory = mkdtempSync('/tmp/delphi-native-mcp-'), bridge = resolve(process.env.DELPHI_TEST_MCP_BRIDGE ?? '.delphi-build/native/delphi-mcp'), socketPath = directory + '/mcp.sock';
const plans = new LocalPlans(new PlanStore(directory), directory + '/plans');
const socket = await startMcpSocket(plans, socketPath);
const token = directory + '/research/mcp-token';
try {
    const plan = plans.create({ title: 'Native handoff verification', objective: 'Verify retrieval', method: 'Retrieve this exact plan over the native bridge', evidence: [], steps: ['Read plan'], acceptance: ['Plan ID matches'], dependencies: [], constraints: ['No execution'], openQuestions: [] }, {});
    const planGrantId = pairPlans(plans, token);
    assert.equal(pairPlans(plans, token), planGrantId);
    for (let connection = 0; connection < 2; connection++) {
    const client = new Client({ name: 'native-plan-test', version: '1' });
    installLauncher(directory, bridge, socketPath, planGrantId, token);
    await client.connect(new StdioClientTransport({ command: 'delphi-mcp', env: { PATH: directory + '/.local/bin:' + process.env.PATH }, stderr: 'inherit' }));
    try {
        assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['get_plan', 'read_plan_source']);
        assert.equal((await client.callTool({ name: 'record_plan_progress', arguments: { plan_id: plan.id } })).isError, true);
        const response = await client.callTool({ name: 'get_plan', arguments: { plan_id: plan.id } });
        assert.notEqual(response.isError, true);
        assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).plan_id, plan.id);
    } finally { await client.close(); }
    }
    console.log('Native file-token pairing, stdio MCP, socket authentication, reconnect and PATH launcher plan retrieval passed.');
}
finally {
    socket.close();
    plans.store.close();
    rmSync(directory, { recursive: true, force: true });
}
