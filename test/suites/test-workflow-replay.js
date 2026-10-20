const assert = require('node:assert/strict');
const Tools = require('pixl-tools');
const API = require('../../lib/api');
const Workflows = require('../../lib/workflow');
const Jobs = require('../../lib/job');
const Util = require('../../lib/util');

// Let completion callbacks tick the workflow without starting a server or satellite.
async function settleWorkflow() {
	await new Promise(resolve => setImmediate(resolve));
}

// Exercise the real node, controller, replay and completion methods. Only storage
// and new job launches are held in memory, so tests control every asynchronous read.
function createReplayFixture(opts = {}) {
	const targets = Array.from({ length: opts.count || 1 }, (_, idx) => 'server' + idx);
	const worker = { id: 'worker', type: opts.type || 'job', data: {
		plugin: 'plugin', event: 'child_event', params: {}, targets,
		replay: opts.replay === undefined ? ['saved_a', 'saved_b'] : opts.replay
	} };
	const controller = { id: 'controller', type: 'controller', data: {
		controller: opts.controller, repeat: opts.count, split: 'data.items', continue: 100
	} };
	const job = opts.job || { id: 'parent', event: 'workflow_event', type: 'workflow', state: 'active',
		limits: [{ type: 'retry', enabled: true, amount: 1 }],
		workflow: {
			start: opts.controller ? 'controller' : 'worker',
			nodes: opts.controller ? [controller, worker] : [worker],
			connections: opts.controller ? [{ id: 'control', source: 'controller', dest: 'worker' }] : []
		}
	};
	if (opts.next && !opts.job) {
		job.workflow.nodes.push({ id: 'next', type: 'job', data: { plugin: 'plugin', params: {} } });
		job.workflow.connections.push({ id: 'output', source: 'worker', dest: 'next',
			condition: opts.condition || (opts.controller ? 'continue' : 'success') });
	}
	
	const records = {};
	['a', 'b'].forEach(function(letter) {
		const id = 'saved_' + letter;
		records[id] = { id, event: 'child_event', code: 0, completed: 100, elapsed: 1,
			data: { items: [letter] }, files: [{ filename: letter + '.txt', job: id }],
			tags: ['tag_' + letter], workflowData: { shared: [letter] }
		};
	});
	const details = { input: job.input || { data: { items: targets } } };
	const queued = [], reads = [], loaded = [], launched = [], finished = [];
	let released = 0;
	const engine = Object.assign(new Workflows(), {
		activeJobs: { [job.id]: job }, jobDetails: { [job.id]: details },
		plugins: [{ id: 'plugin', title: 'Plugin' }],
		events: [{ id: 'child_event', title: 'Child', plugin: 'plugin', params: {}, triggers: [], targets }],
		servers: Object.fromEntries(targets.map(id => [id, { id, enabled: true, groups: [] }])),
		config: { get() { return 1000; } },
		getCompletedJobConditions: Jobs.prototype.getCompletedJobConditions,
		abortJob: Jobs.prototype.abortJob,
		mergeConcatInto: Util.prototype.mergeConcatInto,
		logWorkflow() {}, logJob() {}, appendMetaLog() {},
		filterServerByAlerts() { return true; },
		findActiveJobsDeep(criteria) {
			return Object.values(this.activeJobs).filter(child => child.workflow && child.workflow.job === criteria['workflow.job']);
		},
		launchJob(child, callback) {
			child.id = 'new_' + launched.length;
			launched.push(child);
			this.activeJobs[child.id] = child;
			callback(null, child.id);
		},
		finishJob(completed) { finished.push(completed); },
		runWFNode_action() { assert.fail('Replay must not rerun attached lifecycle actions'); },
		storage: { enqueue(task) { queued.push(task); } },
		unbase: { get(index, id, callback) {
			assert.equal(index, 'jobs', 'replays load archived jobs');
			loaded.push(id);
			reads.push({ id, callback });
		} }
	});
	
	return {
		job, engine, details, records, queued, reads, loaded, launched, finished,
		get released() { return released; },
		startReads() {
			while (queued.length) queued.shift()({}, () => { released++; });
		},
		finishRead(idx = 0) {
			const read = reads.splice(idx, 1)[0];
			// Each read returns an independent archive snapshot, including repeated IDs.
			if (records[read.id]) read.callback(null, Tools.copyHash(records[read.id], true));
			else read.callback(Object.assign(new Error('Missing job'), { code: 'NoSuchKey' }));
		},
		async flush() {
			this.startReads();
			while (reads.length) this.finishRead();
			await settleWorkflow();
		},
		async completeChild(code) {
			const child = launched[0];
			child.code = code;
			delete engine.activeJobs[child.id];
			engine.finishWorkflowJob(child);
			await settleWorkflow();
		}
	};
}

exports.tests = [
	
	async function test_workflow_replay_controllers(test) {
		// A shorter run leaves IDs unused; a longer run cycles the original list.
		// Check both controlled node types, including repeated wraparound and the
		// editor's scalar replay, which must reuse the same job on every invocation.
		for (const controller of ['split', 'multiplex', 'repeat']) {
			for (const type of ['job', 'event']) {
				for (const item of [
					{ replay: ['saved_a', 'saved_b'], count: 1 },
					{ replay: ['saved_a', 'saved_b'], count: 2 },
					{ replay: ['saved_a', 'saved_b'], count: 5 },
					{ replay: 'saved_a', count: 3 }
				]) {
					const label = controller + '/' + type + '/' + item.count;
					const definition = Tools.copyHash(item.replay, true);
					const f = createReplayFixture({ ...item, controller, type, next: true });
					const ids = Tools.alwaysArray(definition);
					const expected = Array.from({ length: item.count }, (_, idx) => ids[idx % ids.length]);
					f.engine.startWorkflow(f.job);
					f.engine.tickWorkflow(f.job);
					assert.ok(!f.job.complete, label + ': queued replays keep the workflow alive');
					await f.flush();
					
					assert.deepEqual(f.loaded, expected, label + ': correct replay order and restart');
					assert.equal(f.job.workflow.state.controller.count, item.count, label + ': every invocation completes');
					assert.equal(f.job.workflow.state.controller.active, false, label + ': controller finishes');
					assert.equal(f.launched.length, 1, label + ': only the continuation launches a new job');
					assert.equal(f.launched[0].workflow.node, 'next', label + ': continuation runs');
					assert.ok(f.job.workflow.jobs.worker.every(stub => stub.replay), label + ': all stubs identify replay');
					assert.equal(f.job.workflow.state.worker.loading, 0, label + ': no pending loads');
					assert.equal(f.released, item.count, label + ': all storage queue slots released');
					
					await f.completeChild(0);
					assert.equal(f.job.complete, true, label + ': workflow finishes');
					assert.equal(f.job.code, 0, label + ': successful result');
					assert.deepEqual(f.details.data.items, expected.map(id => id.slice(-1)), label + ': repeated output is preserved');
					assert.deepEqual(f.details.files.map(file => file.job), expected, label + ': repeated files are preserved');
					const node = Tools.findObject(f.job.workflow.nodes, { id: 'worker' });
					assert.deepEqual(node.data.replay, definition, label + ': source definition is unchanged');
					assert.notEqual(f.job.workflow.state.worker.replay, node.data.replay, label + ': runtime list is independent');
				}
			}
		}
	},
	
	async function test_workflow_replay_loading(test) {
		// No controller or live child can keep this workflow alive. The loading
		// counter must cover queued reads, active reads, and out-of-order completion.
		const f = createReplayFixture();
		f.engine.startWorkflow(f.job);
		f.engine.runWorkflowNode({ job: f.job, node: 'worker' });
		f.engine.tickWorkflow(f.job);
		assert.ok(!f.job.complete, 'queued storage tasks keep workflow alive');
		assert.equal(f.job.workflow.state.worker.loading, 2, 'both reads are counted');
		f.startReads();
		f.engine.tickWorkflow(f.job);
		assert.ok(!f.job.complete, 'in-flight reads keep workflow alive');
		f.finishRead(1);
		await settleWorkflow();
		assert.equal(f.job.workflow.state.worker.loading, 1, 'one read remains after out-of-order completion');
		assert.ok(!f.job.complete, 'first completion cannot finish the workflow');
		f.finishRead();
		await settleWorkflow();
		assert.equal(f.finished.length, 1, 'workflow finishes exactly once');
		assert.equal(f.job.code, 0, 'successful result after both reads');
		assert.deepEqual(f.details.data.items, ['b', 'a'], 'both saved outputs reach the result');
	},
	
	async function test_workflow_replay_output_and_routing(test) {
		// Replay uses the saved result and output, not the current invocation's
		// input. Attached actions stay skipped, while normal result wires still run.
		for (const type of ['job', 'event']) {
			for (const code of [0, 1]) {
				const f = createReplayFixture({ type, replay: ['saved_a'], next: true, condition: code ? 'error' : 'success' });
				f.records.saved_a.code = code;
				f.records.saved_a.workflow = { job: 'old_parent', node: 'old_node', redirect: 'wrong' };
				f.job.workflow.nodes.push({ id: 'action', type: 'action' }, { id: 'wrong', type: 'job', data: { plugin: 'plugin', params: {} } });
				f.job.workflow.connections.push(
					{ id: 'attached', source: 'worker', dest: 'action', condition: 'complete' },
					{ id: 'opposite', source: 'worker', dest: 'wrong', condition: code ? 'success' : 'error' }
				);
				const archived = Tools.copyHash(f.records, true);
				f.engine.startWorkflow(f.job);
				await f.flush();
				assert.equal(f.launched.length, 1, 'only the matching result wire launches');
				const child = f.launched[0];
				assert.equal(child.workflow.node, 'next', 'old redirect is discarded');
				assert.deepEqual(child.input.data, archived.saved_a.data, 'saved data goes downstream');
				assert.deepEqual(child.input.files, archived.saved_a.files, 'saved files go downstream');
				assert.deepEqual(child.workflowData, archived.saved_a.workflowData, 'shared data reaches downstream jobs');
				assert.deepEqual(f.job.tags, ['tag_a'], 'saved tags bubble to the workflow');
				assert.equal(f.job.workflow.jobs.worker[0].code, code, 'original result is retained');
				await f.completeChild(0);
				assert.deepEqual(f.details.data.shared, ['a'], 'shared data reaches final workflow output');
				assert.deepEqual(f.records, archived, 'archived job is unchanged');
			}
		}
	},
	
	async function test_workflow_replay_missing_job(test) {
		// Missing archives must abort, and a later read must not revive a completed
		// workflow or hold a storage queue slot open after cancellation.
		const f = createReplayFixture();
		delete f.records.saved_a;
		f.engine.startWorkflow(f.job);
		f.engine.runWorkflowNode({ job: f.job, node: 'worker' });
		f.startReads();
		f.finishRead();
		assert.equal(f.job.complete, true, 'missing replay aborts workflow');
		assert.equal(f.job.code, 'abort', 'missing replay reports an abort');
		assert.match(f.job.description, /Job not found for replay: saved_a/, 'error names missing job');
		f.finishRead();
		await settleWorkflow();
		assert.equal(f.released, 2, 'both queue slots released');
		assert.equal(f.finished.length, 1, 'late read does not finish the workflow twice');
		assert.equal(f.job.workflow.jobs.worker.length, 0, 'late result is ignored');
	},
	
	async function test_workflow_replay_retry(test) {
		// Retry the whole workflow after a downstream failure. Its definition must
		// still contain the full replay list, and the new run must rebuild its state.
		for (const type of ['job', 'event']) {
			const first = createReplayFixture({ type, replay: ['saved_a'], next: true });
			first.engine.startWorkflow(first.job);
			await first.flush();
			await first.completeChild(1);
			assert.ok(first.job.complete && first.job.code, 'first workflow failed');
			let retry;
			const jobs = Object.assign(new Jobs(), {
				jobDetails: first.engine.jobDetails, appendMetaLog() {}, logJob() {},
				launchJob(job, callback) { retry = job; callback(null, 'retry'); }
			});
			jobs.checkRetryJob(first.job);
			assert.deepEqual(retry.workflow.nodes[0].data.replay, ['saved_a'], 'retry keeps original replay list');
			assert.ok(!retry.workflow.state && !retry.workflow.jobs, 'retry clears prior execution state');
			retry.id = 'retry';
			const second = createReplayFixture({ job: retry });
			second.engine.startWorkflow(retry);
			await second.flush();
			assert.deepEqual(second.loaded, ['saved_a'], 'new attempt replays again');
			assert.equal(second.launched.length, 1, 'new attempt runs downstream job again');
			assert.ok(!retry.complete, 'retry waits for its new child');
			assert.deepEqual(second.launched[0].input.data, { items: ['a'] }, 'retry forwards saved output');
			await second.completeChild(0);
			assert.equal(retry.code, 0, 'retry succeeds after downstream success');
			assert.equal(retry.complete, true, 'retry finishes');
		}
	},
	
	async function test_workflow_replay_access(test) {
		// Verify every unique replay ID, including nested arrays and scalar IDs.
		// Use the real job visibility filter for category and target restrictions.
		for (const denied of ['', 'array', 'nested']) {
			const records = {
				a: { id: 'a', category: 'allowed', targets: ['allowed_group'] },
				b: { id: 'b', category: denied === 'array' ? 'other' : 'allowed', targets: ['allowed_group'] },
				c: { id: 'c', category: 'allowed', targets: [denied === 'nested' ? 'other_group' : 'allowed_group'] }
			};
			const workflow = { nodes: [
				{ type: 'job', data: { replay: ['a', 'b', 'a'] } },
				{ type: 'job', data: { replay: 'a' } },
				{ type: 'event', data: { event: 'nested' } }
			] };
			const events = [{ id: 'nested', type: 'workflow', workflow: { nodes: [
				{ type: 'job', data: { replay: ['c', 'a'] } },
				{ type: 'event', data: { event: 'nested' } }
			] } }];
			const snapshot = Tools.copyHash({ workflow, events }, true);
			const loaded = [];
			const api = Object.assign(new API(), {
				events, storage: { concurrency: 2 }, getComputedUser(user) { return user; },
				unbase: { get(index, id, callback) {
					loaded.push(id);
					setImmediate(() => callback(null, records[id]));
				} }
			});
			const user = { privileges: {}, categories: ['allowed'], groups: ['allowed_group'] };
			const error = await new Promise(resolve => api.verifyDeepWorkflowAccess(user, workflow, resolve));
			assert.deepEqual(loaded.sort(), ['a', 'b', 'c'], 'loads each unique replay, even through a workflow cycle');
			if (denied) assert.match(error && error.message, /privileges.*replayed jobs/, 'rejects inaccessible ' + denied + ' replay');
			else assert.ok(!error, 'all replayed jobs are accessible');
			assert.deepEqual({ workflow, events }, snapshot, 'authorization does not consume replay arrays');
		}
	}
	
];
