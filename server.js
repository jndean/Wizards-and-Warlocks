var express = require('express');
var http = require('http');
var path = require('path');
var socketIO = require('socket.io');

var app = express();
var server = http.Server(app);
var io = socketIO(server);
var port = 1701;

app.set('port', port);
app.use('/static', express.static(__dirname + '/static'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

var GameData = require('./static/game_data');


// ----------------- State ---------------- //

var game = {
	phase: 'lobby',
	round: 0,
	sockets: {},
	players: {},
	player_order: [],
	current_player: null,
	moved_this_turn: false,
	log: {
		lines: [],
		formatted: "",
	}
};

var lobby = {
	sockets: {},
	taken_colours: new Set(),
	player_to_colour: {}	
}

function Player(name, colour_id, warlock) {
	this.name = name;
	this.colour_id = colour_id;
	this.is_warlock = warlock;
	this.mouseX = 0.5;
	this.mouseY = 0.5;
	if (warlock) {
		this.current_row = GameData.GALILEI_WARLOCK_SPAWN[0];
		this.current_col = GameData.GALILEI_WARLOCK_SPAWN[1];
		this.base_speed = 2;
	} else {
		this.current_row = GameData.GALILEI_WIZARD_SPAWN[0];
		this.current_col = GameData.GALILEI_WIZARD_SPAWN[1];
		this.base_speed = 1;
	}
	this.sigils = [];
	if (name.startsWith('sigils')) this.sigils = ['Aggression', 'Momentum', 'Resilience'];
	this.active_sigils = new Set();

	this.history = Array(GameData.HISTORY_LENGTH).fill(null);
	this.decoy_choice_required = false;
	this.speed_bonus = false;
	this.alive = true;


	this.update_history = function(update) { 
		this.history.pop();
		this.history.unshift(update);
	}
}


// ----------------- Networking ---------------- //

io.on('connection', (socket) => {
    var player_name = null;

	socket.on('disconnect', () => {
	    if (player_name === null) return;
	    console.log(player_name + " disconnected");
	    if (game.phase == 'lobby') {
	    	delete lobby.sockets[player_name];
	    	if (player_name in lobby.player_to_colour) {
				lobby.taken_colours.delete(lobby.player_to_colour[player_name]);
				delete lobby.player_to_colour[player_name];
	    	}
	    	broadcast_lobby_state();
	    } else {
	    	game.sockets[player_name] = null;
	    }
	});

	socket.on('join', (new_name) => {
	  	if (game.phase == 'lobby') {
		  	if (new_name in lobby.sockets) {
			    console.log(new_name + ' tried to join but someone already has that name');
			    socket.emit('join_fail', 'The name "'+new_name+'" is already taken');
			    return;
			} else {	
				player_name = new_name;
				lobby.sockets[player_name] = socket;

				console.log(player_name + ' joined the lobby');
				socket.emit('join_lobby', player_name);
				broadcast_lobby_state();
			}
		} else if (game.phase == 'game') {
			if (!(new_name in game.sockets)) {
			    socket.emit('join_fail', 'Nobody by that name is part of the game');
			    return;
			}
			if (game.sockets[new_name] != null) {
			    socket.emit('join_fail', 'Someone is already connected with that name');
			    return;
			}
			player_name = new_name;
			game.sockets[player_name] = socket;
			console.log(player_name + ' rejoined the game');
			broadcast_game_state_transition('player_rejoined', {
				player_name: player_name,
				player_order: game.player_order,
				player_to_colour: lobby.player_to_colour,
			}); 
		}
	});

	socket.on('choose_colour', (colour) => {
		if (game.phase != 'lobby' || player_name == null) 
			return;
		if (lobby.taken_colours.has(colour))
			return;
		if (player_name in lobby.player_to_colour)
			lobby.taken_colours.delete(lobby.player_to_colour[player_name])
		lobby.player_to_colour[player_name] = colour;
		lobby.taken_colours.add(colour);
		broadcast_lobby_state();
		socket.emit('do_animation', {
			type : 'character_selected', 
			character_index: colour
		});
	});

	socket.on('start', (map_name) => {
		if (game.phase != 'lobby' || player_name == null) 
			return;
		var num_connections = Object.keys(lobby.sockets).length;
		if (num_connections != lobby.taken_colours.size) {
			console.log('Can\'t start the game, not all players have a colour')
			return;
		}
		start_new_game(map_name);
	});

	socket.on('mouse_update', (args) => {
		if (args.name != player_name) return;
		var player = game.players[player_name];
		player.mouseX = args.mouseX;
		player.mouseY = args.mouseY;
	});

	socket.on('request_move', (args) => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		if (game.moved_this_turn) return;
		
		let player = game.players[player_name];
		if ((player.current_row == args.row) && (player.current_col == args.col)) return;
		
		// Move player
		player.current_row = args.row;
		player.current_col = args.col;
		game.moved_this_turn = true;

		// Figure out what happens
		let noise_coords = null;
		let sigil = null;
		let noise_result = undefined;
		if (GameData.GALILEI_SAFE_BY_COL[args.col].includes(args.row+1)) {
			noise_result = 'safe_space';
			player.update_history(null);
		} else {
			if (game.dangerous_hex_deck.length == 0) {
				new_dangerous_hex_deck();
			}
			noise_result = game.dangerous_hex_deck.pop();
			// Sigil of Silence suppresses noises
			if (player.active_sigils.has('Silence')) {
				noise_result = 'silent';
				player.active_sigils.delete('Silence');
			}
		}
		console.log(player_name, 'get result', noise_result);
		if (noise_result == 'silent') {
			player.update_history(null);
			// If silent on a dangerous hex, player can find a sigil
			if (game.sigil_deck.length == 0) 
				new_sigil_deck();
			sigil = game.sigil_deck.pop();
			if (sigil !== null) {
				player.sigils.push(sigil);
			}
		} else if (noise_result == 'no_choice') {
			noise_coords = [player.current_row, player.current_col];
			player.update_history(['noise', player.current_row, player.current_col]);
		}

		// Communicate the result
		if (noise_result != 'choice') {
			
			if (noise_coords == null) addToLog(player_name + " moved silently");
			else                      addToLog(player_name + " disturbed the aether");

			broadcast_game_state_transition('move', {
					moving_player: player_name,
					noise_coords: noise_coords,
				}, 
				private_data={[player_name]: {
					sigil: sigil,
					already_moved: false,
					danger_result: noise_result,
				}}
			);
		} else {
			// Need to ask player where they want to make a noise
			player.decoy_choice_required = true;
			broadcast_game_state_transition(
				'choose_noise', {}, private_data={},
				single_recipient=player_name
			);
		}
	
	});

	socket.on('request_noise', (args) => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		
		let player = game.players[player_name];
		if (!game.players[player_name].decoy_choice_required) return;

		player.decoy_choice_required = false;
		player.update_history(['noise', args.row, args.col]);
		addToLog(player_name + " disturbed the aether");
		
		// Move player
		broadcast_game_state_transition('move', {
				moving_player: player_name,
				noise_coords: [args.row, args.col],
			}, 
			private_data={[player_name]: {
				sigil: null,
				already_moved: true,
			}}
		);
	});

	
	socket.on('request_attack', (args) => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		if (game.moved_this_turn) return;
		
		let player = game.players[player_name];
		if ((player.current_row == args.row) && (player.current_col == args.col)) return;
		if (!player.is_warlock && !player.active_sigils.has('Aggression')) return;

		// Move player
		player.current_row = args.row;
		player.current_col = args.col;
		player.update_history(['attack', args.row, args.col]);
		game.moved_this_turn = true;

		// Has anybody been killed?
		let killed = [];
		let killed_warlocks = [];
		let resilient = [];
		for (const [name_, target] of Object.entries(game.players)) {
			if (name_ == player_name ||
				target.current_row != args.row ||
				target.current_col != args.col ||
				!target.alive) continue;
			
			if (target.is_warlock) {
				killed.push(target);
				killed_warlocks.push(target);
			} else if (target.sigils.includes('Resilience')) {
				// Sigil of resilience automatically protects, then is consumed
				resilient.push(target);
				target.sigils.splice(target.sigils.indexOf('Resilience'), 1);
			} else {
				killed.push(target);
			}
		}

		if (killed.length > 0) {
			addToLog(player_name + " attacked, killing " + killed.map(p => p.name).join(' and ') + '.');
			if (player.is_warlock) player.speed_bonus = true;
			killed.forEach(p => {
				p.alive = false;
				p.update_history(['dead', args.row, args.col]);
				if (p.is_warlock) killed_warlocks.push(p);
			});
		}
		if (resilient.length > 0) {
			let msg = '';
			if (killed.length == 0) msg = player_name + " attacked, but ";
			msg += resilient.map(p => p.name).join(' and ') + ' had a Sigil of Resilience!';
			addToLog(msg);
		}
		if ((killed.length == 0) && (resilient.length == 0)) {
			addToLog(player_name + " attacked, but nobody was there!");
		}

		broadcast_game_state_transition('attack',{
			attacker: player_name,
			row: args.row,
			col: args.col,
			killed: killed.map(p => p.name),
			killed_warlocks: killed_warlocks.map(p => p.name),
			resilient: resilient.map(p => p.name),
		});
	});


	socket.on('request_discard', (sigil) => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		
		let player = game.players[player_name];
		if (player.sigils.length <= GameData.MAX_SIGILS) return;
		if (player.sigils[sigil.idx] != sigil.name) return;

		player.sigils.splice(sigil.idx, 1);
		addToLog(player_name + " discarded a sigil");
		
		broadcast_game_state_transition(
			'discard',
			data={
				discarding_player: player_name
			},
			private_data={[player_name]: {
				sigil_idx: sigil.idx
			}}
		);
		
	});


	socket.on('request_use_sigil', (sigil) => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		
		let player = game.players[player_name];
		if (player.sigils[sigil.idx] != sigil.name) return;

		// Prevent players using sigils in ways that don't make sense
		let reject_message = null;
		if (sigil.name == 'Resilience') {
			reject_message = 'Reslience is a passive sigil, you do not activate it';
		} else if (player.active_sigils.has(sigil.name)) {
			reject_message = 'You have already activated a <br>Sigil of ' + sigil.name + ' <br>this turn';
		} else if (game.moved_this_turn && (sigil.name == 'Aggression' || 
											sigil.name == 'Silence' ||
											sigil.name == 'Momentum')) {
			reject_message = 'You must activate a Sigil of ' + sigil.name + ' before moving for it to be useful';
		} else if (
			sigil.name == 'Transposition' && 
			player.current_row == GameData.GALILEI_WIZARD_SPAWN[0] &&
			player.current_col == GameData.GALILEI_WIZARD_SPAWN[1]
		) {
			reject_message = 'You are already on the starting space';
		}
		if (reject_message !== null) {
			broadcast_game_state_transition('reject_use_sigil', {},
				private_data={[player_name]: {
					msg: reject_message,
				}},
				single_recipient=player_name,
			);
			return;
		}

		// Activate sigil
		if (sigil.name != 'Transposition' && sigil.name != 'Detection') {
			player.active_sigils.add(sigil.name);
		}
		player.sigils.splice(sigil.idx, 1);
		addToLog(player_name + ' activated a Sigil of ' + sigil.name);

		if (sigil.name == 'Momentum') {
			player.speed_bonus = true;
		} else if (sigil.name == 'Transposition') {
			player.current_row = GameData.GALILEI_WIZARD_SPAWN[0];
			player.current_col = GameData.GALILEI_WIZARD_SPAWN[1];
		}
		// TODO: Should be able to use Detection twice in a turn

		broadcast_game_state_transition('sigil', {
				player: player_name, 
				name: sigil.name
			},
			private_data={[player_name]: {idx: sigil.idx}}
		);
	});


	socket.on('finish_actions', args => {
		if (game.phase != 'game') return;
		if (player_name != game.player_order[game.current_player]) return;
		if (!game.moved_this_turn) return;
		if (game.players[player_name].sigils.length > GameData.MAX_SIGILS) return;

		// Clear up state from this turn
		game.moved_this_turn = false;
		let player = game.players[player_name];
		player.active_sigils.forEach(sigil => {
			if (sigil == 'Momentum') player.speed_bonus = false;
		});
		player.active_sigils = new Set();

		// Move onto next player
		do {
			game.current_player = (game.current_player + 1) % game.player_order.length;
			if (game.current_player == 0) {
				game.round += 1;
			}
			var alive = game.players[game.player_order[game.current_player]].alive;
		} while (!alive);


		broadcast_game_state_transition('next_player', {
			player_name: game.player_order[game.current_player]
		});
	});
});


server.listen(port, () => {console.log('listening on port ' + port.toString());});


// ----------- Actions ------------ //

function broadcast_lobby_state() {
	var lobby_state = {
		players: [],
		colour_to_player: {}
	};
	for (var name_ in lobby.sockets) {
		lobby_state.players.push(name_);
		if (name_ in lobby.player_to_colour)
 			lobby_state.colour_to_player[lobby.player_to_colour[name_]] = name_;
	}

	io.sockets.emit('lobby_state', lobby_state);
}


function broadcast_mouse_positions() {
	var positions = {};
	for (const [name_, player] of Object.entries(game.players)) {
		positions[name_] = [player.mouseX, player.mouseY];
	}

	io.sockets.emit('mouse_update', positions);
}

var mousePollHandle = undefined;
function start_new_game(map_name) {
	// Wizards & Warlocks: Trouble in the Great Library?
	console.log('Starting game with map: ' + map_name);
	
	// Shuffle role cards
	var roles = new Array(lobby.taken_colours.size).fill(false);
	for (let i = 0; i < Math.ceil(roles.length / 2); ++i) {
		roles[i] = true;
	}
	shuffle(roles);
	
	// Create Players
	for (const [name_, colour_id] of Object.entries(lobby.player_to_colour)) {
		game.players[name_] = new Player(name_, colour_id, roles.pop());
		game.player_order.push(name_);
		game.sockets[name_] = lobby.sockets[name_];
	}
	shuffle(game.player_order);
	lobby.sockets = {};

	// Create decks
	new_dangerous_hex_deck();
	new_sigil_deck();

	addToLog("The lights go out, the hunt begins...");
	
	// Starting the game is a 2-part, 2-message process
	game.phase = 'starting';
	game.current_player = 0;
	game.round = 0;
	broadcast_game_state_transition('start_game_init_state', {
		map_name: map_name,
		player_order: game.player_order,
		player_to_colour: lobby.player_to_colour,
	});
	game.phase = 'game';
	broadcast_game_state_transition('start_game_animation', {});

	mousePollHandle = setInterval(broadcast_mouse_positions, 100);
}

function new_dangerous_hex_deck() {
	// console.log("DEBUG: USING DUFF DECK")
	// game.dangerous_hex_deck = 
	// 	new Array(1).fill('no_choice').concat(
	// 		new Array(1).fill('choice')).concat(
	// 			new Array(23).fill('silent'));
	game.dangerous_hex_deck = 
		new Array(27).fill('no_choice').concat(
			new Array(27).fill('choice')).concat(
				new Array(23).fill('silent'));
	shuffle(game.dangerous_hex_deck);
}

function new_sigil_deck() {
	// There are some dud (null) items
	game.sigil_deck = new Array(5).fill(null).concat([
		'Aggression',
		'Aggression',
		'Transposition',
		'Silence',
		'Silence',
		'Silence',
		'Detection',
		'Detection',
		'Resilience',
		'Momentum',
		'Momentum',
		'Momentum',
	]);
	shuffle(game.sigil_deck);
}


// -------------- Utilities -------------- //


function broadcast_game_state_transition(
	transition_name, 
	data, 
	private_data={},
	single_recipient=null,
) {
	// Serialise the game state.
	// Start with state given to all players
	let common_state = {
		phase: game.phase,
		current_player: game.current_player,
		round: game.round,
		players: {},
		moved_this_turn: game.moved_this_turn,
		log: game.log.formatted,
	};
	for (const [name, player] of Object.entries(game.players)) {
		common_state.players[name] = {
			alive: player.alive,
			num_sigils: player.sigils.length,
			history: player.history,
		}
	}

	// Next customise the state with player-specific (secret) data
	for (const [name, socket] of Object.entries(game.sockets)) {
		if (socket == null) continue;
		if ((single_recipient != null) && (single_recipient != name)) continue;
		
		let player = game.players[name];
		let player_state = {...common_state};
		player_state.sigils = player.sigils;
		player_state.is_warlock = player.is_warlock;
		player_state.player_row = player.current_row;
		player_state.player_col = player.current_col;
		player_state.decoy_choice_required = player.decoy_choice_required;
		player_state.active_sigils = Array.from(player.active_sigils);
		player_state.movement_speed = player.base_speed + player.speed_bonus;

		if (private_data.hasOwnProperty(name)) {
			data = Object.assign({...private_data[name]}, data);
		}

		socket.emit('state_transition', {
			name: transition_name,
			data: data,
			new_state: player_state,
		});
	}
}

function addToLog(msg) {
	const prompt = ">>  ";
	let lines = game.log.lines;
	lines.unshift(msg);
	while (lines.length > 6) lines.pop();
	game.log.formatted = prompt + lines.join('<br>' + prompt);
}

function shuffle(a) {
	for(let repetition = 0; repetition < 7; ++repetition) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
	    }
	}
    return a;
}