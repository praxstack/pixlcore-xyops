const assert = require('node:assert/strict');
const Tools = require('pixl-tools');
const Scheduler = require('../../lib/schedule.js');

// helper: sleep
async function sleep(ms) {
	await new Promise(res => setTimeout(res, ms));
}

async function testTriggers(ctx, triggers, epoch) {
	// test a set of triggers in our test event
	let self = ctx;
	let xy = self.xy;
	let event = Tools.findObject( xy.events, { id: self.schedule_event_id } );
	assert( !!event, "expected to find our event in xy.events" );
	
	// swap in our custom triggers
	let old_triggers = event.triggers;
	event.triggers = triggers;
	
	// hijack launchJob
	let jobs = [];
	let old_launchJob = xy.launchJob;
	xy.launchJob = function(job, callback) {
		self.logDebug(9, "Intercepted launchJob", job);
		jobs.push(job);
		if (callback) callback(null, job.id);
	};
	
	try {
		// run scheduler tick with custom time args
		xy.schedulerMinuteTick({ epoch });
		
		// scheduled launches are staggered, so wait for the entire queue to drain
		await new Promise( function(resolve) {
			if (xy.launchQueue.idle()) return resolve();
			xy.launchQueue.drain = resolve;
		} );
		
		// return array of launched jobs
		return jobs;
	}
	finally {
		// always restore everything after all queued launches have completed
		event.triggers = old_triggers;
		xy.launchJob = old_launchJob;
	}
}

exports.tests = [
	
	async function test_scheduler_dst_minute_epochs(test) {
		// Exercise real scheduler ticks with an isolated event and intercepted launches.
		// Both occurrences of a repeated local minute must keep their distinct epochs.
		const original_timezone = process.env.TZ;
		
		try {
			for (const timezone of ['Europe/Berlin', 'UTC']) {
				process.env.TZ = timezone;
				
				for (const day of ['2026-10-25', '2026-03-29']) {
					const start = Date.parse(day + 'T00:00:00Z') / 1000;
					
					for (const catch_up of [false, true]) {
						const state = {};
						const jobs = [];
						const expected = [];
						let tick;
						const xy = Object.assign(new Scheduler(), {
							master: true,
							lastMonthDayCache: {},
							config: { get() { return 'Europe/Berlin'; } },
							categories: [{ id: 'dst', enabled: true }],
							plugins: [],
							events: [{ id: 'dst', category: 'dst', enabled: true, triggers: [
								{ type: 'schedule', enabled: true, timezone: 'Europe/Berlin', minutes: [0, 15, 30, 45] },
								{ type: 'catchup', enabled: catch_up }
							] }],
							getState(key) { return state[key]; },
							putState(key, value) { state[key] = value; },
							logScheduler() {},
							enqueueLaunch(job) { jobs.push({ tick, now: job.now }); }
						});
						
						// Include both sides of the transition and nonzero tick seconds.
						// Quarter-hour runs stay evenly spaced across fall-back and spring-forward.
						for (tick = start; tick <= start + 7200; tick += 60) {
							xy.schedulerMinuteTick({ epoch: tick + 7 });
							if ((tick - start) % 900 == 0) expected.push({ tick, now: tick });
						}
						
						assert.deepEqual(jobs, expected, `${timezone}, ${day}, catch-up ${catch_up}: every slot launches on time with its actual epoch`);
						if (catch_up) assert.equal(state['events/dst/cursor'], start + 7200, 'catch-up cursor advances through every real minute');
					}
				}
			}
		}
		finally {
			// Restore synchronously before the test runner or any server timer resumes.
			if (original_timezone === undefined) delete process.env.TZ;
			else process.env.TZ = original_timezone;
		}
	},
	
	async function test_create_event_for_scheduling(test) {
		// create new event (non-workflow)
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Job Test Event",
			"enabled": true,
			"category": 'general',
			"targets": ["main"],
			"algo": "random",
			"plugin": "shellplug",
			"params": { "script": "#!/bin/bash\necho hello\n", "annotate": false, "json": false },
			"limits": [  ],
			"actions": [  ],
			"triggers": [ { "type": "manual", "enabled": true } ],
			"notes": "Created by unit tests"
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.id, "expected event in response" );
		this.schedule_event_id = data.event.id;
	},
	
	async function test_scheduler_negative(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 28 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch" );
	},
	
	async function test_scheduler_every_minute(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": []
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_hourly(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_daily(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_weekly(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"weekdays": [ 4 ],
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_monthly(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"days": [ 18 ],
				"weekdays": [ 4 ],
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_yearly(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"months": [ 12 ],
				"days": [ 18 ],
				"weekdays": [ 4 ],
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_custom(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"years": [ 2025 ],
				"months": [ 12 ],
				"days": [ 18 ],
				"weekdays": [ 4 ],
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_custom_negative(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"years": [ 2025 ],
				"months": [ 12 ],
				"days": [ 18 ],
				"weekdays": [ 3 ],
				"hours": [ 18 ],
				"minutes": [ 29 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch" );
	},
	
	async function test_scheduler_timezone(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"hours": [ 21 ], // +3 hours from pacific
				"minutes": [ 29 ],
				"timezone": "America/New_York"
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_timezone_negative(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"hours": [ 18 ], // wrong hour for ny
				"minutes": [ 29 ],
				"timezone": "America/New_York"
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch" );
	},
	
	async function test_scheduler_interval(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "interval",
				"duration": 90,
				"start": 1766111250
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_interval_sub_minute(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "interval",
				"duration": 30,
				"start": epoch
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 2, "expected 2 jobs to launch" );
		
		// make sure jobs are spaced correctly
		assert.ok( jobs[0].state == 'start_delay', "expected job state to be start_delay" );
		assert.ok( jobs[0].until == epoch, "expected job until to be " + epoch );
		
		assert.ok( jobs[1].state == 'start_delay', "expected job state to be start_delay" );
		assert.ok( jobs[1].until == epoch + 30, "expected job until to be " + epoch + "+30" );
	},
	
	async function test_scheduler_single_shot(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "single",
				"epoch": epoch
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_catch_up(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 27, 28, 29 ]
			},
			{
				"enabled": true,
				"type": "catchup"
			}
		];
		
		// set cursor state for event, set to 30 min in the past
		this.xy.putState( 'events/' + this.schedule_event_id + '/cursor', epoch - 1800 );
		
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 3, "expected 3 jobs to launch" );
		
		// make sure jobs are set to the correct now times for catch-up
		assert.ok( jobs[0].now == epoch - 120, "expected job idx 0 to have now set to epoch-120" );
		assert.ok( jobs[1].now == epoch - 60, "expected job idx 1 to have now set to epoch-60" );
		assert.ok( jobs[2].now == epoch, "expected job idx 2 to have now set to epoch" );
	},
	
	async function test_scheduler_single_shot_catch_up(test) {
		// A missed Single Shot must match its historical cursor minute, not the current tick.
		let epoch = 1766111340;
		let single_epoch = epoch - 120;
		let triggers = [
			{
				"enabled": true,
				"type": "single",
				"epoch": single_epoch
			},
			{
				"enabled": true,
				"type": "catchup"
			}
		];
		
		// The stored cursor is the last processed minute, so replay starts one minute later.
		this.xy.putState( 'events/' + this.schedule_event_id + '/cursor', epoch - 180 );
		
		let jobs = await testTriggers(this, triggers, epoch);
		assert.equal( jobs.length, 1, "expected the missed Single Shot to launch once" );
		assert.equal( jobs[0].now, single_epoch, "expected the Single Shot to retain its scheduled minute" );
	},
	
	async function test_scheduler_interval_catch_up(test) {
		// A 90-second interval shifts between :00 and :30, making cursor mistakes visible.
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "interval",
				"duration": 90,
				"start": epoch - 270
			},
			{
				"enabled": true,
				"type": "catchup"
			}
		];
		
		this.xy.putState( 'events/' + this.schedule_event_id + '/cursor', epoch - 240 );
		
		let jobs = await testTriggers(this, triggers, epoch);
		assert.equal( jobs.length, 3, "expected each missed interval hit to launch exactly once" );
		assert.deepEqual(
			jobs.map( function(job) { return job.now; } ),
			[ epoch - 180, epoch - 90, epoch ],
			"expected interval hits to be calculated from each historical cursor minute"
		);
	},
	
	async function test_scheduler_range_in(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "range",
				"start": epoch - 30,
				"end": epoch + 30
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_range_out(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "range",
				"start": epoch + 1800,
				"end": epoch + 3600
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch" );
	},
	
	async function test_scheduler_blackout_in(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "blackout",
				"start": epoch - 30,
				"end": epoch + 30
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch" );
	},
	
	async function test_scheduler_blackout_out(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "blackout",
				"start": epoch + 1800,
				"end": epoch + 3600
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
	},
	
	async function test_scheduler_delay(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "delay",
				"duration": 30
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 1, "expected 1 job to launch" );
		assert.ok( jobs[0].state == 'start_delay', "expected job state to be start_delay" );
		assert.ok( jobs[0].until == epoch + 30, "expected job until to be epoch+30" );
	},
	
	async function test_scheduler_precision(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "precision",
				"seconds": [ 0, 15, 30, 45 ]
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 4, "expected 4 jobs to launch" );
		
		assert.ok( jobs[0].state == 'start_delay', "expected job idx 0 state to be start_delay" );
		assert.ok( jobs[0].until == epoch, "expected job idx 0 until to be epoch+0" );
		
		assert.ok( jobs[1].state == 'start_delay', "expected job idx 1 state to be start_delay" );
		assert.ok( jobs[1].until == epoch + 15, "expected job idx 1 until to be epoch+15" );
		
		assert.ok( jobs[2].state == 'start_delay', "expected job idx 2 state to be start_delay" );
		assert.ok( jobs[2].until == epoch + 30, "expected job idx 2 until to be epoch+30" );
		
		assert.ok( jobs[3].state == 'start_delay', "expected job idx 3 state to be start_delay" );
		assert.ok( jobs[3].until == epoch + 45, "expected job idx 3 until to be epoch+45" );
	},
	
	async function test_create_scheduler_plugin(test) {
		// create new scheduler plugin that always launches (+1 sec delay)
		let node_bin = Tools.findBinSync('node');
		assert.ok( !!node_bin, "expected to find node in PATH or standard dirs" );
		
		let { data } = await this.request.json( this.api_url + '/app/create_plugin/v1', {
			title: 'Unit Test Plugin',
			enabled: true,
			type: 'scheduler',
			command: node_bin,
			script: `setTimeout( function() { console.log( JSON.stringify({ "xy":1, "items": [ true ] }) ); }, 500 );\n`,
			params: [ { id: 'foo', type: 'text', title: 'Foo', value: '' } ],
			notes: 'Created by unit tests'
		});
		assert.ok( data.code === 0, 'successful api response' );
		assert.ok( data.plugin && data.plugin.id, 'expected plugin in response' );
		this.scheduler_plugin_id = data.plugin.id;
	},
	
	async function test_scheduler_plugin(test) {
		// test epoch = 1766111340 (2025/12/18 18:29:00 Pacific)
		let self = this;
		let epoch = 1766111340;
		let triggers = [
			{
				"enabled": true,
				"type": "schedule",
				"minutes": [ 29 ]
			},
			{
				"enabled": true,
				"type": "plugin",
				"plugin_id": this.scheduler_plugin_id,
				"params": {}
			}
		];
		let jobs = await testTriggers(this, triggers, epoch);
		assert.ok( jobs.length == 0, "expected 0 jobs to launch immediately" );
		
		// job will launch deferred, so we have to wait for it
		let old_launchJob = this.xy.launchJob;
		let launched = [];
		this.xy.launchJob = function(job, callback) {
			self.logDebug(9, "Intercepted deferred launchJob", job);
			launched.push(job);
			if (callback) callback(null, job.id);
		};
		
		const timeout = 20000;
		const interval = 250;
		const start = performance.now();
		
		while (performance.now() - start < timeout) {
			if (launched.length) break;
			await sleep(interval);
		}
		
		assert.ok( launched.length == 1, "expected 1 job to launch deferred" );
		
		this.xy.launchJob = old_launchJob;
	},
	
];
