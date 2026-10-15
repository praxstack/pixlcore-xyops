const assert = require('node:assert/strict');
const fs = require('fs');
const Tools = require('pixl-tools');
const Workflows = require('../../lib/workflow');
const Jobs = require('../../lib/job');
const Util = require('../../lib/util');

// helper: sleep
async function sleep(ms) {
	await new Promise(res => setTimeout(res, ms));
}

// helper: poll internal jobs until specified job id disappears
async function waitForJob(ctx, job_id, opts = {}) {
	const timeout = opts.timeout || 20000;
	const interval = opts.interval || 250;
	const start = performance.now();
	
	while (performance.now() - start < timeout) {
		let { data } = await ctx.request.json(ctx.api_url + '/app/get_active_jobs/v1', {});
		if (data.code !== 0) throw new Error('get_active_jobs failed');
		if (!data.rows.find(r => r.id === job_id)) return;
		await sleep(interval);
	}
	
	throw new Error('Timed out waiting for job to finish');
}

// helper: wait for a specific workflow node job to be actively running
async function waitForActiveWorkflowNode(ctx, workflow_job_id, node_id, opts = {}) {
	const timeout = opts.timeout || 20000;
	const interval = opts.interval || 250;
	const start = performance.now();
	
	while (performance.now() - start < timeout) {
		let { data } = await ctx.request.json(ctx.api_url + '/app/get_active_jobs/v1', {
			state: 'active'
		});
		if (data.code !== 0) throw new Error('get_active_jobs failed');
		let job = data.rows.find(function(row) {
			return row.workflow && (row.workflow.job === workflow_job_id) && (row.workflow.node === node_id);
		});
		if (job) return job;
		await sleep(interval);
	}
	
	throw new Error('Timed out waiting for active workflow node: ' + node_id);
}

// helper: load workflow template from fixtures
function getWorkflow(name) {
	const data = JSON.parse( fs.readFileSync('test/fixtures/workflows/' + name + '.json') );
	return data.items[0].data;
}

exports.tests = [
	
	async function test_workflow_isolation_bubbling(test) {
		// Exercise every combination, plus legacy workflows with no opts field.
		// Isolation affects aggregation, while downstream input and Join stay intact.
		const options = ['isolate_data', 'isolate_files', 'isolate_tags', 'isolate_content'];
		const selections = [undefined].concat( Array.from({ length: 16 }, function(value) {
			return options.filter((option, idx) => value & (1 << idx));
		}) );
		
		for (const opts of selections) {
			for (const lifecycle of ['success', 'abort', 'nested']) {
				const isolated = new Set(opts || []);
				const label = (opts === undefined ? 'legacy' : opts.join(',') || 'none') + ': ' + lifecycle;
				const join = { id: 'join', type: 'controller', data: { controller: 'join' } };
				const parent = {
					id: 'parent', tags: ['parent_tag', 'shared_tag'], redraw: 'original',
					table: { title: 'Parent table' }, html: { content: 'Parent HTML' },
					workflow: { state: { join: {} }, jobs: { leaf: [] },
						nodes: [{ id: 'leaf', type: 'job' }, join, { id: 'next', type: 'job' }],
						connections: [
							{ id: 'tagwire', source: 'leaf', dest: 'next', condition: 'tag:child_tag' },
							{ id: 'joinwire', source: 'leaf', dest: 'join', condition: 'continue' },
							{ id: 'outputwire', source: 'join', dest: 'next' }
						]
					}
				};
				if (opts !== undefined) parent.opts = opts;
				if (lifecycle == 'nested') parent.workflow.job = 'outer';
				const parent_file = { filename: 'parent.txt' };
				const shared = { shared: true };
				const details = { data: { parent_only: true, values: ['parent'] }, files: [parent_file],
					workflowData: shared, wfJobData: {} };
				const calls = [];
				let finished = false;
				const engine = Object.assign(new Workflows(), {
					activeJobs: { parent }, jobDetails: { parent: details },
					mergeConcatInto: Util.prototype.mergeConcatInto,
					getCompletedJobConditions: Jobs.prototype.getCompletedJobConditions,
					logWorkflow() {}, runWorkflowNode(call) { calls.push(call); },
					finishJob() { finished = true; }
				});
				const child = { id: 'child', code: 0, workflow: { job: 'parent', node: 'leaf' },
					data: { result: 'child', values: ['child'] }, files: [{ filename: 'child.txt' }],
					tags: ['child_tag', 'shared_tag', '_success'],
					table: { title: 'Child table' }, html: { content: 'Child HTML' },
					workflowData: { updated: true }
				};
				
				// A superseded attempt must contribute no ordinary output or content,
				// even when all isolation options are disabled.
				engine.finishWorkflowJob({ ...child, id: 'retry', code: 1, retried: true,
					data: { retry_only: true }, files: [{ filename: 'retry.txt' }],
					tags: ['retry_tag'], table: { title: 'Retry table' }, html: { content: 'Retry HTML' }
				});
				assert.equal(calls.length, 0, label + ': retry does not continue flow');
				assert.deepEqual(parent.tags, ['parent_tag', 'shared_tag'], label + ': retry does not bubble tags');
				assert.equal(parent.redraw, 'original', label + ': retry does not bubble content');
				
				engine.finishWorkflowJob(child);
				assert.equal(calls.length, 1, label + ': child tag condition still fires');
				assert.deepEqual(calls[0].overrides.input, { data: child.data, files: child.files }, label + ': downstream receives output');
				assert.notEqual(calls[0].overrides.input.data, child.data, label + ': downstream data is copied');
				assert.deepEqual(parent.tags, isolated.has('isolate_tags') ? ['parent_tag', 'shared_tag'] : ['parent_tag', 'shared_tag', 'child_tag'], label + ': user tags bubble selectively and deduplicate');
				assert.deepEqual(parent.table, isolated.has('isolate_content') ? { title: 'Parent table' } : child.table, label + ': table isolation');
				assert.deepEqual(parent.html, isolated.has('isolate_content') ? { content: 'Parent HTML' } : child.html, label + ': HTML isolation');
				assert.equal(parent.redraw == 'original', isolated.has('isolate_content'), label + ': redraw only when content bubbles');
				
				// Join uses the retained per-job results, independently of what the
				// workflow will export, and continues to exclude retry attempts.
				engine.runWFController_join({ job: parent, node: join });
				assert.deepEqual(calls[1].overrides.input, {
					data: { items: [child.data], combined: child.data, percentage: 100 }, files: child.files
				}, label + ': Join retains child data and files');
				if (lifecycle == 'abort') parent.workflow.aborted = 'Test abort';
				
				// Allow the real completion callback scheduled by finishWorkflowJob.
				await new Promise(resolve => setImmediate(resolve));
				assert.ok(finished, label + ': workflow finishes');
				const expected = isolated.has('isolate_data') ? { parent_only: true, values: ['parent'] } :
					{ parent_only: true, result: 'child', values: ['parent', 'child'] };
				if (lifecycle != 'nested') Object.assign(expected, shared);
				assert.deepEqual(details.data, expected, label + ': output data isolation preserves parent data');
				assert.deepEqual(details.files, [parent_file].concat(isolated.has('isolate_files') ? [] : child.files), label + ': file isolation preserves parent files');
				assert.equal(shared.updated, true, label + ': workflowData updates remain shared');
				assert.equal(details.workflowData, lifecycle == 'nested' ? shared : undefined, label + ': shared data promotion follows workflow scope');
				assert.equal(parent.code, lifecycle == 'abort' ? 'abort' : 0, label + ': isolation does not change workflow status');
			}
		}
	},
	
	async function test_workflow_isolation_inheritance(test) {
		// Either source may omit opts. Present arrays must be merged without
		// duplicates or mutation, including when the result launches another workflow.
		const cases = [
			{ name: 'both absent', expected: undefined },
			{ name: 'parent absent', child: ['isolate_files'], expected: ['isolate_files'] },
			{ name: 'child absent', parent: ['isolate_data'], expected: ['isolate_data'] },
			{ name: 'both empty', parent: [], child: [], expected: [] },
			{ name: 'parent empty', parent: [], child: ['isolate_files'], expected: ['isolate_files'] },
			{ name: 'child empty', parent: ['isolate_data'], child: [], expected: ['isolate_data'] },
			{ name: 'overlapping options', parent: ['isolate_data', 'isolate_tags', 'isolate_content'],
				child: ['isolate_data', 'isolate_files'], expected: ['isolate_data', 'isolate_files', 'isolate_tags', 'isolate_content'] }
		];
		
		for (const item of cases) {
			const event = { id: 'nested', title: 'Nested', params: {}, actions: [], limits: [],
				triggers: [{ id: 'manual', type: 'manual', enabled: true }], workflow: { nodes: [], connections: [] } };
			const parent = { id: 'parent', workflow: { state: { nested: {} }, jobs: {}, connections: [] } };
			if (item.child !== undefined) event.opts = Object.freeze(item.child.slice());
			if (item.parent !== undefined) parent.opts = Object.freeze(item.parent.slice());
			const children = [];
			const engine = Object.assign(new Workflows(), {
				events: [event], jobDetails: { parent: { workflowData: {} } },
				config: { get() { return 1000; } }, countTotalWFJobs() { return 0; }, logWorkflow() {},
				launchJob(job, callback) { children.push(job); callback(null, 'child' + children.length); }
			});
			engine.runWFNode_event({ job: parent, node: { id: 'nested', data: { event: 'nested' } } });
			assert.deepEqual(children[0].opts, item.expected, item.name + ': correct inherited options');
			assert.deepEqual(event.opts, item.child, item.name + ': saved options are unchanged');
			assert.deepEqual(parent.opts, item.parent, item.name + ': parent options are unchanged');
			if (item.expected) {
				assert.notEqual(children[0].opts, event.opts, item.name + ': child has its own array');
				assert.notEqual(children[0].opts, parent.opts, item.name + ': parent array is not shared');
			}
			
			// A second generation retains the complete union, including when neither
			// workflow defined options. The normal event path must not inherit them.
			const nested = children[0];
			Object.assign(nested, { id: 'child', workflow: { state: { nested: {}, ordinary: {} }, jobs: {}, connections: [] } });
			engine.jobDetails.child = { workflowData: {} };
			engine.runWFNode_event({ job: nested, node: { id: 'nested', data: { event: 'nested' } } });
			assert.deepEqual(children[1].opts, item.expected, item.name + ': second generation retains options');
			engine.events.push({ id: 'ordinary', title: 'Ordinary', params: {}, triggers: [], actions: [], limits: [] });
			engine.runWFNode_event({ job: nested, node: { id: 'ordinary', data: { event: 'ordinary' } } });
			assert.ok(!Object.hasOwn(children[2], 'opts'), item.name + ': ordinary events do not inherit workflow options');
		}
	},
	
	async function test_workflow_isolation_options_api(test) {
		// Check the real create/update/run validation paths without launching jobs.
		// Sparse updates must preserve stored options when omitted and clear them
		// when an empty array is explicitly saved.
		const workflow = getWorkflow('decision');
		workflow.id = 'eisolationopts';
		workflow.opts = ['isolate_data', 'isolate_files', 'isolate_tags', 'isolate_content'];
		let { data: created } = await this.request.json(this.api_url + '/app/create_event/v1', workflow);
		assert.equal(created.code, 0, 'workflow with isolation options is accepted');
		assert.deepEqual(created.event.opts, workflow.opts, 'create preserves isolation options');
		
		try {
			for (const opts of [{}, 'isolate_data', 1, true]) {
				for (const operation of ['create', 'update', 'run']) {
					const params = operation == 'create' ? { ...workflow, id: 'einvalidisolationopts', opts } : { id: workflow.id, opts };
					let { data } = await this.request.json(this.api_url + '/app/' + operation + '_event/v1', params);
					assert.notEqual(data.code, 0, operation + ': non-array opts are rejected');
					assert.match(data.description, /invalid opts.*must be array/, operation + ': rejection identifies opts');
				}
			}
			
			let { data: updated } = await this.request.json(this.api_url + '/app/update_event/v1', { id: workflow.id, notes: 'Sparse update' });
			assert.equal(updated.code, 0, 'sparse update is accepted');
			assert.deepEqual(updated.event.opts, workflow.opts, 'sparse update preserves stored options');
			let { data: cleared } = await this.request.json(this.api_url + '/app/update_event/v1', { id: workflow.id, opts: [] });
			assert.equal(cleared.code, 0, 'empty option array is accepted');
			assert.deepEqual(cleared.event.opts, [], 'empty array clears isolation');
		}
		finally {
			let { data } = await this.request.json(this.api_url + '/app/delete_event/v1', { id: workflow.id });
			assert.equal(data.code, 0, 'isolation test workflow is cleaned up');
		}
	},
	
	async function test_workflow_subworkflow_output_data(test) {
		// Two inner workflows share the parent's data, but their ordinary output
		// must contain only their own job results when the parent collects a Join.
		const shared = {
			owner: 'parent', dealers: ['Dealer A', 'Dealer B'],
			result: { code: 'PARENT_VALUE' }
		};
		const inner_node = { id: 'inner', type: 'event' };
		const join_node = { id: 'join', type: 'controller', data: { controller: 'join' } };
		const parent = { id: 'parent', workflow: {
			nodes: [inner_node, join_node, { id: 'final', type: 'job' }],
			state: { join: {} }, jobs: { inner: [] },
			connections: [
				{ source: 'inner', dest: 'join', condition: 'continue' },
				{ source: 'join', dest: 'final' }
			]
		} };
		const finished = {};
		let joined;
		const engine = Object.assign(new Workflows(), {
			activeJobs: { parent },
			jobDetails: { parent: { workflowData: shared, wfJobData: {} } },
			mergeConcatInto: Util.prototype.mergeConcatInto,
			getCompletedJobConditions: Jobs.prototype.getCompletedJobConditions,
			logWorkflow() {},
			runWorkflowNode(opts) { joined = opts.overrides.input.data; },
			finishJob(job) {
				// Model finishJob's final record and parent notification without storage.
				const completed = finished[job.id] = Tools.mergeHashes(job, this.jobDetails[job.id]);
				delete this.activeJobs[job.id];
				delete this.jobDetails[job.id];
				if (job.workflow.job) this.finishWorkflowJob(completed);
			}
		});
		
		const outputs = shared.dealers.map( function(dealer) {
			return { result: { key: [dealer], code: 'SUCCESS' } };
		} );
		const children = outputs.map( function(data, idx) {
			const id = 'inner' + idx;
			const leaf_id = 'leaf' + idx;
			const child = { id, workflow: {
				job: parent.id, node: inner_node.id, nodes: [], connections: [], state: {},
				jobs: { leaf: [{ id: leaf_id, code: 0 }] }
			} };
			engine.activeJobs[id] = child;
			engine.jobDetails[id] = { workflowData: shared, wfJobData: { [leaf_id]: data } };
			return child;
		} );
		
		// Complete the actual inner workflow aggregation and parent collection.
		children.forEach( function(child, idx) {
			engine.tickWorkflow(child);
			assert.deepEqual(finished[child.id].data, outputs[idx], 'inner output excludes shared fields and preserves colliding result');
			assert.equal(finished[child.id].workflowData, shared, 'inner workflow retains its shared object for parent completion');
		} );
		engine.runWFController_join({ job: parent, node: join_node });
		assert.deepEqual(joined.items, outputs, 'each Join item contains only its corresponding inner output');
		assert.equal(joined.percentage, 100, 'both inner runs succeeded');
		assert.deepEqual(shared.dealers, ['Dealer A', 'Dealer B'], 'inner completions do not duplicate shared arrays');
		
		// The parent completion scheduled by finishWorkflowJob still exports
		// shared data at the top level, including its existing key precedence.
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(finished.parent.data.owner, 'parent', 'top-level workflow promotes shared data');
		assert.deepEqual(finished.parent.data.dealers, shared.dealers, 'top-level output contains the shared list once');
		assert.deepEqual(finished.parent.data.result, shared.result, 'top-level promotion retains shared key precedence');
		assert.ok(!Object.hasOwn(finished.parent, 'workflowData'), 'top-level workflow removes promoted workflowData');
	},
	
	async function test_workflow_shared_data_merge(test) {
		// Completion may return the exact shared object, including when startup
		// actions abort a sub-workflow before its normal completion cleanup.
		const cases = [
			{ name: 'shared successful completion', shared: true, code: 0 },
			{ name: 'shared startup abort', shared: true, code: 'abort' },
			{ name: 'shared retry', shared: true, code: 1, retried: true },
			{ name: 'separate sparse update', update: { dealers: ['Dealer C'], status: 'updated' } },
			{ name: 'equal values in a separate object', update: { dealers: ['Dealer A', 'Dealer B'] } },
			{ name: 'no update' }
		];
		
		cases.forEach( function(item) {
			const shared = { owner: 'parent', dealers: ['Dealer A', 'Dealer B'] };
			const parent = { id: 'parent', complete: true, workflow: {
				nodes: [{ id: 'inner', type: 'event' }], jobs: { inner: [] }
			} };
			const details = { workflowData: shared, wfJobData: {} };
			const engine = Object.assign(new Workflows(), {
				activeJobs: { parent }, jobDetails: { parent: details },
				mergeConcatInto: Util.prototype.mergeConcatInto, logWorkflow() {}
			});
			const child = { id: 'child', code: item.code || 0, retried: item.retried,
				workflow: { job: parent.id, node: 'inner' }, data: { result: 'SUCCESS' }
			};
			if (item.shared) child.workflowData = shared;
			else if (item.update) child.workflowData = item.update;
			
			// Keep the parent complete to isolate result collection from new nodes.
			engine.finishWorkflowJob(child);
			const expected = ['Dealer A', 'Dealer B'].concat(item.update ? item.update.dealers : []);
			assert.deepEqual(shared.dealers, expected, item.name + ': only separate updates concatenate arrays');
			assert.equal(shared.owner, 'parent', item.name + ': inherited scalar remains available');
			if (item.update && item.update.status) assert.equal(shared.status, 'updated', 'sparse update adds new keys');
			assert.deepEqual(details.wfJobData.child, item.retried ? {} : child.data, item.name + ': ordinary output collection is preserved');
		} );
	},
	
	async function test_workflow_magic_inheritance(test) {
		// Event nodes, ad-hoc jobs and nested workflows all receive the request
		// that started the parent. Inheritance depends on metadata, not source.
		var magic = {
			headers: { 'linear-signature': 'original' }, body: '{ "text": "café" }',
			params: { unknown: { value: 42 } }, query: { caller: 'original' }
		};
		for (var has_magic of [true, false]) {
			var children = [];
			var engine = Object.assign(new Workflows(), {
				events: [
					{ id: 'event', title: 'Event', params: {}, triggers: [], actions: [], limits: [] },
					{ id: 'nested', title: 'Nested Workflow', params: {}, actions: [], limits: [],
						workflow: { nodes: [], connections: [] }, triggers: [{ id: 'manual', type: 'manual', enabled: true }] }
				],
				plugins: [{ id: 'plugin', title: 'Plugin' }],
				config: { get() { return 1000; } },
				jobDetails: { parent: { workflowData: {} } },
				countTotalWFJobs() { return 0; }, logWorkflow() {},
				launchJob(job, callback) { children.push(job); callback(null, 'child_' + children.length); }
			});
			if (has_magic) engine.jobDetails.parent.magic = magic;
			var parent = {
				id: 'parent', event: 'workflow_event', source: 'user', params: {},
				workflow: { state: { event: {}, job: {}, nested: {} }, jobs: {}, connections: [] }
			};
			
			engine.runWFNode_event({ job: parent, node: { id: 'event', data: { event: 'event' } } });
			engine.runWFNode_job({ job: parent, node: { id: 'job', data: { plugin: 'plugin', params: {} } } });
			engine.runWFNode_event({ job: parent, node: { id: 'nested', data: { event: 'nested' } } });
			assert.equal(children.length, 3, 'all three node types launch');
			assert.equal(children[2].workflow.start, 'manual', 'nested workflow retains its own start node');
			
			// launchJob moves a nested workflow's metadata to its own details.
			// Start another job from that context to exercise a second generation.
			engine.jobDetails.nested_job = { workflowData: {} };
			if (children[2].magic) engine.jobDetails.nested_job.magic = children[2].magic;
			var nested = {
				id: 'nested_job', event: 'nested', source: 'workflow', params: {},
				workflow: { state: { job: {} }, jobs: {}, connections: [] }
			};
			engine.runWFNode_job({ job: nested, node: { id: 'job', data: { plugin: 'plugin', params: {} } } });
			
			for (var child of children) {
				if (has_magic) assert.deepEqual(JSON.parse(JSON.stringify(child)).magic, magic, 'child inherits original metadata through JSON transport');
				else assert.ok(!Object.hasOwn(child, 'magic'), 'ordinary workflow does not acquire Magic Link metadata');
				assert.ok(!Object.hasOwn(child.params, 'unknown'), 'metadata does not leak into child params');
			}
		}
	},
	
	async function test_workflow_split_empty_continue(test) {
		// Empty lists may continue only when the Split does not require successful jobs.
		const cases = [
			{ name: 'continue zero', percentage: 0, continues: true },
			{ name: 'default continue zero', continues: true },
			{ name: 'positive threshold', percentage: 50 },
			{ name: 'all success threshold', percentage: 100 },
			{ name: 'previous successes', percentage: 100, previous: true },
			{ name: 'filtered empty list', percentage: 0, filter: true, continues: true },
			{ name: 'filtered positive threshold', percentage: 100, filter: true },
			{ name: 'unmanaged positive threshold', percentage: 100, unmanaged: true }
		];
		
		cases.forEach( function(item) {
			const engine = new Workflows();
			const node = { id: 'split', type: 'controller', data: {
				controller: 'split', split: 'data.items', continue: item.percentage,
				filter: item.filter ? 'item.keep' : ''
			} };
			const worker = { id: 'worker', type: item.unmanaged ? 'controller' : 'job' };
			const state = {};
			const job = { id: 'parent', workflow: {
				nodes: [node, worker, { id: 'final', type: 'job' }],
				state: { split: state }, jobs: {},
				connections: [
					{ id: 'splitWorker', source: 'split', dest: 'worker' },
					{ id: 'workerContinue', source: 'worker', dest: 'final', condition: 'continue' }
				]
			} };
			
			// A previous activation's successful jobs must not satisfy an empty activation.
			if (item.previous) job.workflow.jobs.worker = [{ id: 'previous', code: 0 }];
			engine.jobDetails = { parent: { workflowData: {} } };
			engine.logWorkflow = function() {};
			const launched = [];
			engine.runWorkflowNode = function(opts) { launched.push(opts.node.id); };
			
			engine.runWFController_split({ job, node, overrides: { input: {
				data: { items: item.filter ? [{ keep: false }] : [] }
			} } });
			
			assert.deepEqual(launched, item.continues ? ['final'] : [], item.name + ': correct continuation');
			assert.equal(!!state.error, !item.continues, item.name + ': preserves errors at positive thresholds');
			if (item.continues) {
				assert.equal(state.active, false, item.name + ': Split is inactive');
				assert.equal(state.max, 0, item.name + ': no jobs expected');
				assert.equal(state.count, 0, item.name + ': no jobs completed');
				assert.ok(state.completed, item.name + ': Split is completed');
			}
		} );
	},
	
	async function test_workflow_join_percentage(test) {
		// Exercise Join's output directly, without launching downstream jobs.
		const cases = [
			{ name: 'all succeed', top: [0, 0], bottom: [0], percentage: 100 },
			{ name: 'mixed unequal branches', top: [0, 1], bottom: [0], percentage: 66.66666666666666 },
			{ name: 'none succeed', top: [1, 'warning'], bottom: ['abort'], percentage: 0 },
			{ name: 'retry succeeds', top: [{ code: 1, retried: true }, 0], bottom: [0], percentage: 100 },
			{ name: 'no output data', top: [0], bottom: [1], percentage: 50 },
			{ name: 'below one percent', top: [0], bottom: Array(100).fill(1), percentage: 0.9900990099009901 },
			{ name: 'no job results', top: [], bottom: [], percentage: null }
		];
		
		cases.forEach( function(item) {
			const engine = new Workflows();
			const node = { id: 'join' };
			const jobs = {};
			['top', 'bottom'].forEach( function(source) {
				jobs[source] = item[source].map( function(result, idx) {
					return { id: source + idx, ...(typeof(result) == 'object' ? result : { code: result }) };
				} );
			} );
			const job = { id: 'parent', workflow: {
				jobs, state: { join: {} }, nodes: [{ id: 'final' }],
				connections: [{ source: 'top', dest: 'join' }, { source: 'bottom', dest: 'join' }, { source: 'join', dest: 'final' }]
			} };
			engine.jobDetails = { parent: { wfJobData: {} } };
			engine.logWorkflow = function() {};
			let data;
			engine.runWorkflowNode = function(opts) { data = opts.overrides.input.data; };
			
			// Both input wires must arrive before the final input is generated.
			engine.runWFController_join({ job, node });
			assert.equal(data, undefined, item.name + ': waits for both inputs');
			engine.runWFController_join({ job, node });
			assert.equal(data.percentage, item.percentage, item.name + ': correct success percentage');
			assert.equal(data.items.length, jobs.top.concat(jobs.bottom).filter(stub => !stub.retried).length, item.name + ': includes terminal jobs without output');
		} );
	},
	
	async function test_workflow_reject_duplicate_node_id(test) {
		// The API should reject duplicate workflow node IDs instead of silently repairing them.
		let workflow = getWorkflow('decision');
		workflow.id = 'edupnode01';
		workflow.workflow.nodes.push( Tools.copyHash(workflow.workflow.nodes[0], true) );
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate node ID" );
	},
	
	async function test_workflow_reject_duplicate_connection_id(test) {
		// The API should reject duplicate workflow connection IDs.
		let workflow = getWorkflow('decision');
		workflow.id = 'edupconn01';
		
		let conn = Tools.copyHash(workflow.workflow.connections[0], true);
		conn.source = workflow.workflow.connections[1].source;
		conn.dest = workflow.workflow.connections[1].dest;
		workflow.workflow.connections.push(conn);
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate connection ID" );
	},
	
	async function test_workflow_reject_duplicate_connection_pair(test) {
		// The API should reject duplicate wires between the same source and destination nodes.
		let workflow = getWorkflow('decision');
		workflow.id = 'eduppair01';
		
		let conn = Tools.copyHash(workflow.workflow.connections[0], true);
		conn.id = 'cduppair';
		workflow.workflow.connections.push(conn);
		
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( data.code !== 0, "api rejected duplicate connection pair" );
	},
	
	async function test_update_active_workflow(test) {
		// Update a future workflow node while xySat is delaying the current node.
		const first_node_id = 'nk42jgcz';
		const future_node_id = 'nqe6dmpv';
		let workflow = getWorkflow('decision');
		workflow.id = 'eactiveupdate';
		workflow.title = 'Active Workflow Update Test';
		Tools.findObject(workflow.workflow.nodes, { id: first_node_id }).data.params.duration = '4';
		
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', workflow );
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		
		let { data:run_data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: wflow.event.id } );
		assert.ok( run_data.code === 0, "successful api response" );
		assert.ok( run_data.id, "expected workflow job id" );
		let job_id = run_data.id;
		
		// Wait until the first node is definitely executing, then fetch the live
		// workflow so we can replace its complete nodes array.
		await waitForActiveWorkflowNode( this, job_id, first_node_id );
		let { data:before_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( before_data.code === 0 && before_data.job, "expected active workflow job" );
		assert.ok( before_data.job.workflow.state[first_node_id], "workflow has live state before update" );
		
		let nodes = Tools.copyHash(before_data.job.workflow.nodes, true);
		let future_node = Tools.findObject(nodes, { id: future_node_id });
		future_node.data.targets = ['satunit1'];
		
		// Only send nodes.  The API should shallow-merge the workflow object and
		// preserve its connections, runtime state and completed-job history.
		let { data:update_data } = await this.request.json( this.api_url + '/app/update_active_job/v1', {
			id: job_id,
			workflow: { nodes: nodes }
		});
		assert.ok( update_data.code === 0, "active workflow update succeeded" );
		
		let { data:live_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( live_data.code === 0 && live_data.job, "expected updated active workflow job" );
		assert.ok( live_data.job.workflow.connections.length === before_data.job.workflow.connections.length, "workflow connections were preserved" );
		assert.ok( live_data.job.workflow.state[first_node_id], "workflow runtime state was preserved" );
		assert.deepEqual( Tools.findObject(live_data.job.workflow.nodes, { id: future_node_id }).data.targets, ['satunit1'], "future node targets were updated" );
		
		// The current node completes after its mock delay, then the workflow should
		// launch the future node using its new target and finish normally.
		await waitForJob( this, job_id );
		let { data:final_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: job_id } );
		assert.ok( final_data.code === 0 && final_data.job, "expected completed workflow job" );
		assert.ok( final_data.job.code === 0, "updated workflow completed successfully" );
		assert.ok( final_data.job.workflow.jobs[future_node_id], "updated future node was launched" );
		
		let child_job_id = final_data.job.workflow.jobs[future_node_id][0].id;
		let { data:child_data } = await this.request.json( this.api_url + '/app/get_job/v1', { id: child_job_id } );
		assert.ok( child_data.code === 0 && child_data.job, "expected completed future node job" );
		assert.deepEqual( child_data.job.targets, ['satunit1'], "future node used its updated targets" );
	},
	
	async function test_workflow_decision(test) {
		// test multi-job workflow with decision controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('decision'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nk42jgcz = "Generate Data"
		// nqe6dmpv = "Hi" (data.num == 42)
		// n8qpiq1i = "There" (data.num != 42)
		
		assert.ok( jobs['nk42jgcz'], "Found jobs for node nk42jgcz");
		assert.ok( jobs['nk42jgcz'].length == 1, "Exactly one job for node nk42jgcz");
		
		assert.ok( jobs['nqe6dmpv'], "Found jobs for node nqe6dmpv");
		assert.ok( jobs['nqe6dmpv'].length == 1, "Exactly one job for node nqe6dmpv");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 2, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 2, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 2, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
	},
	
	async function test_workflow_repeat_join(test) {
		// test multi-job workflow with repeat and join controllers
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('repeat-join'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// n5r4k75x = "Generate Data" (x5)
		// nbzpuk59 = "Finalize Data" (x1)
		
		assert.ok( jobs['n5r4k75x'], "Found jobs for node n5r4k75x");
		assert.ok( jobs['n5r4k75x'].length == 5, "Exactly five jobs for node n5r4k75x (generate data)");
		
		assert.ok( jobs['nbzpuk59'], "Found jobs for node nbzpuk59");
		assert.ok( jobs['nbzpuk59'].length == 1, "Exactly one job for node nbzpuk59 (finalize data)");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 6, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true // need this for data!
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 6, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 6, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure final job has correct merged (joined) data
		var final_job_id = jobs['nbzpuk59'][0].id;
		var final_job = Tools.findObject( sjdata.jobs, { id: final_job_id } );
		assert.ok( !!final_job, "Found final job in sea of completed jobs" );
		
		assert.ok( !!final_job.input, "Found input object in final job" );
		assert.ok( !!final_job.input.data, "Found input data in final job" );
		assert.ok( !!final_job.input.data.items, "Found items in input data in final job" );
		assert.ok( final_job.input.data.items.length == 5, "Correct number of items in input data in final job" );
		assert.equal( final_job.input.data.percentage, 100, "Joined success percentage reaches final job input" );
		
		assert.ok( !!final_job.input.data.combined, "Found combined object in input data in final job" );
		assert.ok( final_job.input.data.combined.num == 42, "Correct data in combined object in input data in final job" );
	},
	
	async function test_workflow_discrete_join(test) {
		// test multi-job workflow with join controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('discrete-join'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nxew2z8t = "Generate Data 1"
		// nriolmha = "Generate Data 2"
		// ndl4jafi = "Finalize Data"
		
		assert.ok( jobs['nxew2z8t'], "Found jobs for node nxew2z8t");
		assert.ok( jobs['nxew2z8t'].length == 1, "Exactly 1 job for node nxew2z8t (generate data 1)");
		
		assert.ok( jobs['nriolmha'], "Found jobs for node nriolmha");
		assert.ok( jobs['nriolmha'].length == 1, "Exactly 1 job for node nriolmha (generate data 1)");
		
		assert.ok( jobs['ndl4jafi'], "Found jobs for node ndl4jafi");
		assert.ok( jobs['ndl4jafi'].length == 1, "Exactly 1 job for node ndl4jafi (finalize data)");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 3, "correct number of sub-jobs ran" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true // need this for data!
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 3, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 3, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure final job has correct merged (joined) data
		var final_job_id = jobs['ndl4jafi'][0].id;
		var final_job = Tools.findObject( sjdata.jobs, { id: final_job_id } );
		assert.ok( !!final_job, "Found final job in sea of completed jobs" );
		
		// console.log( "\nFINAL JOB: ", JSON.stringify(final_job, null, "\t") );
		
		assert.ok( !!final_job.input, "Found input object in final job" );
		assert.ok( !!final_job.input.data, "Found input data in final job" );
		assert.ok( !!final_job.input.data.items, "Found items in input data in final job" );
		assert.ok( final_job.input.data.items.length == 2, "Correct number of items in input data in final job" );
		
		assert.ok( !!final_job.input.data.combined, "Found combined object in input data in final job" );
		assert.ok( final_job.input.data.combined.num == 42, "Correct data in combined object in input data in final job" );
	},
	
	async function test_workflow_multiplex(test) {
		// test multi-job workflow with multiplex controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('multiplex'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { id: workflow_id });
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nizewm42 = job
		// n68r2e20 = action
		
		assert.ok( jobs['nizewm42'], "Found jobs for node nizewm42");
		assert.ok( jobs['nizewm42'].length == 1, "Exactly one job for node nizewm42");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 1, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 1, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 1, "all jobs are complete and successful" );
		
		job_ids.forEach( function(job_id, idx) {
			assert.ok( !!Tools.findObject(sjdata.jobs, { id: job_id }), "found job idx " + idx );
		} );
		
		// make sure action ran
		assert.ok( !!state['n68r2e20'], "found state for action node" );
		assert.ok( state['n68r2e20'].code == 0, "action node has code 0" );
		assert.ok( !!state['n68r2e20'].date, "action node has date prop" );
	},
	
	async function test_workflow_split(test) {
		// test multi-job workflow with split controller
		let { data:wflow } = await this.request.json( this.api_url + '/app/create_event/v1', getWorkflow('split'));
		assert.ok( wflow.code === 0, "successful api response" );
		assert.ok( wflow.event && wflow.event.id, "expected event in response" );
		let workflow_id = wflow.event.id;
		
		let { data } = await this.request.json( this.api_url + '/app/run_event/v1', { 
			id: workflow_id,
			input: {
				data: {
					list: ["Item A", "Item B", "Item C"]
				}
			}
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.id, "expected id in response" );
		let job_id = data.id;
		
		// wait for workflow to complete
		await waitForJob( this, job_id );
		
		// get job data
		let { data:jdata } = await this.request.json( this.api_url + '/app/get_job', { id: job_id });
		assert.ok( jdata.code === 0, "successful api response" );
		assert.ok( jdata.job, "expected job in response" );
		
		let job = jdata.job;
		let state = job.workflow.state;
		let jobs = job.workflow.jobs;
		
		// console.log( "\nWORKFLOW: ", JSON.stringify(jdata.job, null, "\t") );
		
		// assertions here
		assert.ok( job.code == 0, "workflow completed successfully" );
		
		// job node IDs:
		// nan42bp0 = job
		
		assert.ok( jobs['nan42bp0'], "Found jobs for node nan42bp0");
		assert.ok( jobs['nan42bp0'].length == 3, "Exactly three jobs for node nan42bp0");
		
		var job_ids = [];
		for (var node_id in jobs) {
			jobs[node_id].forEach( function(job) { job_ids.push( job.id ); } );
		}
		assert.ok( job_ids.length == 3, "correct number of sub-jobs" );
		
		// fetch all of them at once
		let { data:sjdata } = await this.request.json( this.api_url + '/app/get_jobs', {
			ids: job_ids,
			verbose: true
		});
		assert.ok( sjdata.code === 0, "successful api response" );
		assert.ok( sjdata.jobs, "expected jobs in response" );
		assert.ok( sjdata.jobs.length == 3, "correct number of jobs in response" );
		assert.ok( Tools.findObjects(sjdata.jobs, { complete: true, code: 0 }).length == 3, "all jobs are complete and successful" );
		
		// make sure each sub-job was assigned one item from our split
		var split_items = [];
		job_ids.forEach( function(job_id, idx) {
			var sub_job = Tools.findObject(sjdata.jobs, { id: job_id });
			// console.log( "\nJOB " + idx + ": ", JSON.stringify(sub_job, null, "\t") );
			assert.ok( !!sub_job, "found sub-job idx " + idx );
			assert.ok( !!sub_job.input, `found sub-job idx ${idx} input object` );
			assert.ok( !!sub_job.input.data, `found sub-job idx ${idx} input.data object` );
			assert.ok( !!sub_job.input.data.item, `found sub-job idx ${idx} input.data.item` );
			assert.ok( !!sub_job.input.data.item.match(/^Item\s+\w+$/), `sub-job idx ${idx} input.data.item matches expected string pattern` );
			split_items.push( sub_job.input.data.item );
		} );
		
		// make sure all three items are unique
		assert.ok( new Set(split_items).size === split_items.length, "all split item strings are unique" );
	}

];
