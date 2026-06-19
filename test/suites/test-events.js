const assert = require('node:assert/strict');
const Tools = require('pixl-tools');

exports.tests = [

	async function test_api_get_events(test) {
		// list all events
		let { data } = await this.request.json( this.api_url + '/app/get_events/v1', {} );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( Array.isArray(data.rows), "expected rows array" );
		assert.ok( data.list && (data.list.length >= 0), "expected list metadata" );
	},

	async function test_api_get_event_missing_param(test) {
		// missing id param
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_create_event_missing_plugin(test) {
		// create event missing plugin should error (non-workflow)
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event",
			"enabled": true,
			"category": this.category_final_id || 'general',
			"targets": ["main"]
		});
		assert.ok( !!data.code, "expected error for missing plugin" );
	},

	async function test_api_create_event_missing_targets(test) {
		// create event missing targets should error (non-workflow)
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 2",
			"enabled": true,
			"category": this.category_final_id || 'general',
			"plugin": "shellplug"
		});
		assert.ok( !!data.code, "expected error for missing targets" );
	},

	async function test_api_create_event_invalid_limit(test) {
		// invalid limit (duration must be number for time)
		const category_id = this.category_final_id || 'general';
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 3",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"plugin": "shellplug",
			"limits": [ { enabled: true, type: 'time', duration: 'nope' } ]
		});
		assert.ok( !!data.code, "expected error for invalid limit" );
	},

	async function test_api_create_event_invalid_action(test) {
		// invalid action (email requires users array or email string)
		const category_id = this.category_final_id || 'general';
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Bad Event 4",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"plugin": "shellplug",
			"actions": [ { enabled: true, condition: 'error', type: 'email' } ]
		});
		assert.ok( !!data.code, "expected error for invalid action" );
	},

	async function test_api_create_event(test) {
		// create new event (non-workflow)
		const category_id = this.category_final_id || 'general';
		let { data } = await this.request.json( this.api_url + '/app/create_event/v1', {
			"title": "Unit Test Event",
			"enabled": true,
			"category": category_id,
			"targets": ["main"],
			"algo": "random",
			"plugin": "shellplug",
			"params": { "script": "#!/bin/bash\necho hello\n", "annotate": false, "json": false },
			"limits": [ { enabled: true, type: 'time', duration: 60 } ],
			"actions": [ { enabled: true, condition: 'error', type: 'email', users: ['admin'] } ],
			"triggers": [ { "type": "manual", "enabled": true } ],
			"notes": "Created by unit tests"
		});
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.id, "expected event in response" );
		this.event_id = data.event.id;
	},

	async function test_api_get_new_event(test) {
		// fetch our new event
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.id === this.event_id, "event id unexpected" );
		assert.ok( Array.isArray(data.jobs) && typeof data.queued === 'number', "expected jobs and queued in response" );
		assert.ok( Array.isArray(data.event.limits) && data.event.limits.length === 1, "expected one limit" );
		assert.ok( data.event.limits[0].type === 'time' && data.event.limits[0].duration === 60, "unexpected limit content" );
		assert.ok( Array.isArray(data.event.actions) && data.event.actions.length === 1, "expected one action" );
		assert.ok( data.event.actions[0].type === 'email' && data.event.actions[0].enabled === true, "unexpected action content" );
	},

	async function test_api_event_rejects_reserved_job_override(test) {
		// reserved _xy_override_* params must not be allowed to alter launch context
		let event = Tools.findObject( this.xy.events, { id: this.event_id } );
		let error = null;
		let valid = this.xy.requireValidEventData(
			Tools.mergeHashes(event, { params: { _xy_override_uid: '0' } }),
			function(data) { error = data; }
		);

		assert.ok( valid === false, "reserved job override should fail validation" );
		assert.ok( error && error.code === 'api', "expected api validation error" );
		assert.ok( error.description.match(/reserved/), "expected reserved-key error" );
	},

	async function test_api_update_event_missing_id(test) {
		// update without id should error
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', { title: 'oops' } );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_update_event(test) {
		// update our event
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			title: 'UTE v2',
			notes: 'updated by tests'
		});
		assert.ok( data.code === 0, "successful api response" );
	},

	async function test_api_update_event_invalid_limit(test) {
		// invalid limit on update (file.amount must be number)
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			limits: [ { enabled: true, type: 'file', amount: 'nope' } ]
		});
		assert.ok( !!data.code, "expected error for invalid limit on update" );
	},

	async function test_api_update_event_invalid_action(test) {
		// invalid action on update (invalid condition)
		let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
			id: this.event_id,
			actions: [ { enabled: true, condition: 'nope', type: 'email', users: ['admin'] } ]
		});
		assert.ok( !!data.code, "expected error for invalid action on update" );
	},

	async function test_api_update_event_locked_script_non_admin_api_key(test) {
		// create a non-admin API key that can edit events, but cannot edit locked params
		let created = await this.request.json( this.api_url + '/app/create_api_key/v1', {
			title: 'Unit Test Event Edit API Key',
			description: 'Created by event unit tests',
			active: 1,
			privileges: { edit_events: 1 }
		});
		assert.ok( created.data.code === 0, "successful api key creation" );
		assert.ok( created.data.api_key && created.data.api_key.id, "expected api key in response" );
		assert.ok( created.data.plain_key, "expected plain api key" );
		
		let api_key_id = created.data.api_key.id;
		let plain_key = created.data.plain_key;
		let original_script = "#!/bin/bash\necho hello\n";
		let hostile_script = "#!/bin/bash\necho pwned\n";
		
		try {
			// attempt to bypass the admin lock by omitting plugin and sending a new script
			let { data } = await this.request.json( this.api_url + '/app/update_event/v1', {
				id: this.event_id,
				title: 'UTE v3',
				params: {
					script: hostile_script,
					annotate: true,
					json: false
				}
			}, {
				headers: {
					'X-Session-ID': '',
					'X-API-Key': plain_key
				}
			} );
			assert.ok( data.code === 0, "successful non-admin api response" );
			assert.ok( data.event && data.event.title === 'UTE v3', "expected unlocked event title update" );
			assert.ok( data.event.params.script === original_script, "locked script should remain unchanged" );
			assert.ok( data.event.params.script !== hostile_script, "locked script should reject non-admin override" );
			assert.ok( data.event.params.annotate === true, "unlocked param should still update" );
			
			// verify the persisted event too, not just the update_event response
			let fetched = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
			assert.ok( fetched.data.code === 0, "successful get_event response" );
			assert.ok( fetched.data.event.params.script === original_script, "persisted locked script should remain unchanged" );
			assert.ok( fetched.data.event.params.script !== hostile_script, "persisted locked script should reject non-admin override" );
			assert.ok( fetched.data.event.params.annotate === true, "persisted unlocked param should still update" );
		}
		finally {
			// clean up the temporary key even if the security assertion fails
			await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: api_key_id } );
		}
	},
	
	async function test_api_get_updated_event(test) {
		// verify updates
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( data.event && data.event.title === 'UTE v3', "unexpected event title" );
		assert.ok( data.event.notes === 'updated by tests', "unexpected event notes" );
		assert.ok( data.event.params.script === "#!/bin/bash\necho hello\n", "locked script should remain unchanged" );
	},

	async function test_api_get_event_history(test) {
		// fetch history for our event
		let { data } = await this.request.json( this.api_url + '/app/get_event_history/v1', { id: this.event_id, limit: 50 } );
		assert.ok( data.code === 0, "successful api response" );
		assert.ok( Array.isArray(data.rows), "expected rows array" );
		assert.ok( data.list && (data.list.length >= 1), "expected at least one history record" );
	},

	async function test_api_run_event_stub(test) {
		// per request: do not exercise run_event here
		assert.ok(true, 'run_event test intentionally skipped (stub/no-op)');
	},

	async function test_api_delete_event_missing_id(test) {
		// delete without id should error
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', {} );
		assert.ok( !!data.code, "expected error for missing id" );
	},

	async function test_api_delete_event_nonexistent(test) {
		// delete non-existent event should error
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', { id: 'nope' } );
		assert.ok( !!data.code, "expected error for missing event" );
	},

	async function test_api_delete_event(test) {
		// delete our event
		let { data } = await this.request.json( this.api_url + '/app/delete_event/v1', { id: this.event_id } );
		assert.ok( data.code === 0, "successful api response" );
	},

	async function test_api_get_event_deleted(test) {
		// ensure deleted
		let { data } = await this.request.json( this.api_url + '/app/get_event/v1', { id: this.event_id } );
		assert.ok( !!data.code, "expected error for missing event" );
		delete this.event_id;
	},

];
