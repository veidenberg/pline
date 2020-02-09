//=== Pline web interface generator for command-line tools === //
// http://wasabiapp.org/pline
// Andres Veidenberg (andres.veidenberg[at]helsinki.fi), University of Helsinki, 2019
// Licensed under the MIT licence: https://opensource.org/licenses/MIT
// Compatible with IE 9+ and all the other web browsers

if(!window.ko) console.error('Pline dependancy missing: Knockout.js library');
//String.includes() polyfill
if (!String.prototype.includes) {
  String.prototype.includes = function(search, start) {
    'use strict';
    if (search instanceof RegExp) {
      throw TypeError('first argument must not be a RegExp');
    } 
    if (start === undefined) { start = 0; }
    return this.indexOf(search, start) !== -1;
  };
}
//includes() for multiple values
String.prototype.includesAny = function(){
	for(var i in arguments){
		if(this.includes(arguments[i])) return true;
	}
	return false;
}

//Pline object
var Pline = {
	plugins: {}, //plugin datamodels container
	pipeline: ko.observableArray(), //list of plugin IDS currently in the pipeline
	submitted: ko.observable(false), //submit button pressed
	sending: ko.observable(false), //sending input data to server
	//global Pline settings
	settings: {
	  sendmail: false, //enable email notifications (false|true|'pipelines'=only for pipelines)
	  email: '', //predefined email address
	  presets: true, //enable presets (stored plugin launch parameters)
	  UIcontainer: 'body', //default container element for plugin interfaces (CSS selector | DOM element)
	  pipelines: true, //enable pipelines (send multiple commands. false=show one plugin interface at a time)
	  pipes: true, //enable pipes in pipelines/commands (set false on unsopperted systems e.g. Windows)
	  sendAddress: '', //backend web server URL
	  sendData: {}, //default POST data, sent with each job (object: {key:value,...})
	  cleanup: false //true = remove interface after job has been sent to server
	},
	//pipeline config file import/export state
	config:{
		edit: ko.observable(), //save pipeline (configfile) mode
		name: ko.observable(), //new configfile name
		desc: ko.observable(), //new pipeline description
		message: ko.observable(''), //open/save feedback
		errors: ko.observableArray([]), //open/save errors
		logErrors: function(){ //print errors to console
			console.log('Pline pipeline loading failed: '+this.errors().join(' | '));
		},
		includeFiles: false, //include input filenames in the preset
		imported: ko.observable({}) //name+description of the imported pipeline
	},
	//Pline public functions:
	//parse & register new plugin
	addPlugin: function(data, pluginpath){ //data = Pline.plugin(obj) | JSON(obj/str) | JSON URL(str)
		if(!data){
			console.log('Failed to import a Pline plugin: input missing (JSON or URL expected)!');
			return;
		}
		var json, url, plugin;
		if(typeof(data)=='string'){
			if(data.includes('{')) json = data;
			else url = data;
		} else if(typeof(data)=='object'){
			if(data instanceof Pline.plugin) plugin = data;
			else json = data;
		} else {
			console.log('Failed to import a Pline plugin: wrong input type (JSON or URL expected)!');
			return;
		}
		
		if(!plugin) plugin = new Pline.plugin(json, {path: pluginpath}); //init plugin
		if(url){ //download JSON first
			plugin.xhr = $.get(url).done(function(newJSON){
				plugin.json = newJSON; //add data to the plugin instance
				Pline.addPlugin(plugin, pluginpath);
			}).fail(function(obj){ //not JSON
				if (obj.responseText){
					plugin.json = obj.responseText;
					Pline.addPlugin(plugin, pluginpath); //re-parse
				} else {
					plugin.error('Failed to download the plugin JSON from '+url);
					console.log(obj);
				}
			}).always(function(){
				plugin.xhr = '';
			});
			return;
		}
		
		var status = plugin.initPlugin();
		if(status){
			if(status instanceof Pline.plugin) return status;
			if(plugin.debug) console.groupCollapsed(plugin.title+' plugin parser log');
			plugin.parseOptions();
			plugin.ready = true;
			plugin.log('Parsing: second pass', {title:true});
			plugin.parseOptions(); //2nd parsing round
			if(plugin.debug) console.groupEnd();
			plugin.log('= Plugin parsed =', {title:true});
			Pline.plugins[plugin.id] = plugin;
		} else {
			console.log('Plugin import failed. Datamodel dump: %o', plugin);
		}
		
		plugin.registerPlugin(); //hook function
		return plugin;
	},
	
	//store the current pipeline (open plugins+inputvalues) to a JSON file 
	saveConfig: function(){
		var self = this;
		var name = self.config.name();
		if(!name){
			self.config.message('Please type a name for the new config.');
			return;
		}
		self.config.edit(false);
		//store the state of the current pipeline
		var pipeline = [];
		self.pipeline().forEach( function(pID){
			var plugin = self.plugins[pID];
			pipeline.push({
				plugin: plugin.duplicate || pID, //original pluginID
				name: plugin.jobName(),
				inputs: plugin.readInputs()
			});
		});
		//save JSON to Blob and init its download (filesave dialog)
		var savedata = {name: name, pipeline: pipeline};
		if(self.config.desc()) savedata.desc = self.config.desc();
		var blob = new Blob([JSON.stringify(savedata, null, 1)], {type: 'text/json'});
		var filename = name.replace(/ /g, '_')+'.json';
		if(navigator.msSaveOrOpenBlob){ //IE
			navigator.msSaveBlob(blob, filename);
		} else {
			var a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = filename;        
			document.body.appendChild(a);
			a.click();
			setTimeout(function(){ //cleanup
				URL.revokeObjectURL(a.href); 
				document.body.removeChild(a);
			}, 100);
	  }
		self.config.message('Configuration file created.');
	},
	
	//read & open pipeline from a configfile
	readConfig: function(filelist){
		var self = this;
		if(!filelist.length) return;
		var file = filelist.item(0);
		var reader = new FileReader();
		reader.onload = function(){
			try{
				var json = JSON.parse(reader.result);
			} catch {
				self.config.errors.push('Unrecognized fileformat'); return;
			}
			if(typeof(json)!='object' || !json.pipeline){
				self.config.errors.push('No pipeline data in the file'); return;
			}
			self.openPipeline(json);
		};
		reader.readAsText(file);
	},
	
	//restore a pipeline from JSON
	openPipeline: function(json, targetEl){
		var self = this;
		self.config.errors.removeAll();
		if(!json || !json.pipeline){
			self.config.errors.push('Malformed pipeline JSON');
			self.config.logErrors();
			console.log(json);
			return;
		}
		if(targetEl) Pline.settings.UIcontainer = targetEl;
		Pline.clearPipeline();
		self.config.imported({name: json.name||'', desc: json.desc||''});
		//restore the pipeline steps from json
		var plugin = false;
		for(var i=0; i < json.pipeline.length; i++){
			var step = json.pipeline[i];
			if(!step.plugin || !step.inputs){
				self.config.errors.push('Malformed pipeline step JSON');
				break;
			}
			if(!self.plugins[step.plugin]){
				self.config.errors.push('Missing plugin: '+step.plugin);
				break;
			} else {
				plugin = self.plugins[step.plugin].draw(targetEl, 'clone'); //render plugin interface
				setTimeout( function(step){ //fill the inputs
					var data = {name: json.name, preset: step.inputs, URL: json.URL||false};
					this.loadPreset(data, 'quiet');
					if(step.name) this.jobName(step.name);
				}.bind(plugin, step), 1000+(i*100));
			}
		}
		if(!plugin) self.config.logErrors();
		else setTimeout(function(){ self.config.message('Pipeline ready.'); }, 2000);
	},

	//remove all pipeline steps
	clearPipeline: function(remove){
		if(!Pline.pipeline().length) return;
		if(remove) $('.pline', Pline.settings.UIcontainer).remove(); //remove Pline interface
		else $('.pl-plugins', Pline.settings.UIcontainer).empty(); //remove plugin UIs
		Pline.pipeline().forEach( function(name, i){ //remove plugin clones
			if(i) delete Pline.plugins[name];
		});
		Pline.pipeline([]); //clear interface list
		Pline.config.imported({}); //clear pipeline info
	},
	
	//utility function for making collapsible interface sections
	makeSection: function(options){
		var arrow = $('<span class="pl-rotateable'+(options.open?' pl-rotateddown':'')+'">&#x25BA;</span>'), infospan = '';
		var titlespan = $('<span class="pl-action" title="'+(options.desc||'Click to toggle content')+'">'+(options.title||'View/hide')+'</span>');
		var titlediv = $('<div class="pl-expandtitle'+(options.inline?' pl-inline':'')+'">').append(arrow, titlespan);
		if(typeof(options.css)=='object') titlediv.css(options.css);
		
		if(options.info){
			infospan = $('<span class="pl-note" style="display:none;margin-left:20px">'+options.info+'</span>');
			options.onshow = function(){infospan.fadeIn()};
			options.onhide = function(){infospan.fadeOut()};
			titlediv.append(infospan);
		}
		
		titlespan.click(function(){
			var content = options.target||titlespan.parent().siblings(".insidediv, .pl-insidediv").first();
			
			if(arrow.hasClass('pl-rotateddown')){
				arrow.removeClass('pl-rotateddown');
				if(options.keepw){ //keep container width after collapsing its content
					content.css("min-width", content.width());
					content.parent().css("min-width", content.parent().width());
				}
				if(options.minh) content.animate({height:options.minh});
				else content.slideUp();
				if(typeof(options.onhide)=='function') options.onhide();	
			}
			else{
				arrow.addClass('pl-rotateddown');
				if(options.maxh){
					if(isNaN(options.maxh)) options.maxh = content[0].scrollHeight;
					content.animate({height:options.maxh});
				}
				else content.slideDown();
				if(typeof(options.onshow)=='function') options.onshow();
			}
		});
		
		return titlediv;
	},
	
	//make a pop-up menu
	//btn=menu launcher DOM element; items=array[{title:str,click:func}]; arr=menu pointer direction ('top'|'bottom') 
	makeMenu: function(btn, items, arr){
		if(!arr) arr = 'top';
		if(!Array.isArray(items)){
			items = [];
			var plugins = Object.keys(Pline.plugins).sort();
			plugins.forEach( function(pname){ //default menu: the plugins list
				var plugin = Pline.plugins[pname];
				if(plugin.duplicate) return true;
				items.push({
					text: '⚙ '+plugin.title,
					title: 'Add '+plugin.title+' to the pipeline',
					click: function(){ plugin.draw(); }
				});
			});
		}
		//build the menu
		var ul = $('<ul>');
		items.forEach( function(item){
			if(typeof(item.text)!='string' || typeof(item.click)!='function') return;
			$('<li title="'+(item.title||'')+'">'+item.text+'</li>').click(item.click).appendTo(ul);
		});
		
		var menu = $('<div class="pl-tooltip"></div>');
		var tiparrow = $('<div class="pl-arrow"></div>');
		menu.append(tiparrow, $('<div class="pl-tooltipcontentwrap"></div>').append('<div class="pl-tooltipcontent"></div>').append(ul));
		$('body').append(menu);
		
		btn = $(btn); //get menu launcher position
		var targetx = btn.offset().left+((parseInt(btn.css('width')) - parseInt(menu.css('width')))/2)+10;
		var targety = btn.offset().top;
		if(arr=='bottom' && (targety-menu.outerHeight()-20 < 0)) arr = 'top'; //avoid clipping
		if(arr=='top') targety += parseInt(btn.css('height'))+13; //adjust menu location
		else if(arr=='bottom') targety -= menu.outerHeight()+4;
		
		menu.addClass('pl-'+arr+'arrow');
		menu.css({left: parseInt(targetx), top: parseInt(targety)}); //set menu position
		menu.addClass('pl-opaque'); //show the menu
		setTimeout(function(){ $('html').one('click', function(){ Pline.hideMenu(menu); }); }, 100); //hide the menu on click
		return menu;
	},
	
	//hide the plugins menu
	hideMenu: function(menu){
		if(!menu || !menu.length) menu = $('.pl-tooltip');
		menu.removeClass('pl-opaque');
		setTimeout(function(){ menu.remove(); }, 200);
	},

	//search an array of objects with a key/val needle
	indexOfObj: function(objarr, key, val){
		if(!Array.isArray(objarr) || typeof(key) != 'string') return -1;
		for(var i = 0; i < objarr.length; i++){
			var oval = objarr[i][key];
			if(typeof(oval) == 'function' && typeof(val) != 'function') oval = oval();
			if(oval === val) return i;
		}
		return -1;
	},
	
	//replace Pline or plugin functions/variables with custom extensions
	extend: function(extensions){ //extensions = {varName:func/obj/val}
		$.each(extensions, function(name, extension){
			var target = Pline[name]? Pline : Pline.plugin.prototype;
			if(typeof(extension)=='object' && target[name]) Object.assign(target[name], extension);
			else target[name] = extension;
		});
	}
}//Pline

//self-clear configfile exporting status
Pline.config.message.subscribe(function(txt){
	if(txt) setTimeout(function(){ Pline.config.message(''); }, 3000);
});
Pline.config.edit.subscribe(function(editmode){
	if(!editmode){ Pline.config.name(''); Pline.config.desc('');  }
});

//dynamic name of the currently open plugin/pipeline
Pline.title = ko.pureComputed(function(){
	var pl = this.pipeline();
	if(pl.length){
		return this.config.imported().name || this.plugins[pl[0]].title + (pl.length>1? ' pipeline' : '');
	} else {
		return '';
	}
}, Pline).extend({ throttle: 100 });

//dynamic submit button text & title
Pline.sBtn = ko.pureComputed(function(){
	var pl = this.pipeline();
	if(!pl.length){ //empty interface
		return { text: '', title: '' };
	}
	if(Pline.sending()){
		return { text: 'Sending...', title: 'Submitting the task' };
	}
	if(pl.length == 1){ //single plugin
		var plugin = this.plugins[pl[0]];
		var btntxt = plugin.ruleToFunc(plugin.submitBtn)() || 'RUN';
		return { text: btntxt, title: 'Launch '+plugin.title };
	}
	//pipeline
	return { text: 'Run pipeline', title: 'Launch the pipeline' };
}, Pline);

//datamodel for each Pline plugin
Pline.plugin = function(json, opt){
	if(typeof(opt) != 'object'){
		if(typeof(opt) == 'string') opt = {id:opt};
		else opt = {};
	}
	var self = this;
	//plugin state
	self.id = opt.id||'';
	self.title = 'plugin';
	self.program = '';
	self.version = '';
	self.json = json; //json => obj
	self.path = opt.path||''; //plugin json path
	self.prefix = '-'; //params prefix
	self.valueSep = ' '; //params name/value separator
	self.jobName = ko.observable('analysis');
	self.icon = {};
	self.category = '';
	self.outFiles = [];
	self.stdout = ko.observable('output.log');
	self.configFile = '';
	self.configParam = '';
	self.debug = false;
	self.errors = [];
	self.selopt = {};
	self.ready = false;
	self.step = opt.step||0;
	self.duplicate = opt.duplicate||false; //false/id of the source plugin
	self.pipe = ko.observableArray([]); //list of inputs using a pipe
	//stored confirgurations (plugin option values)
	self.presets = ko.observableArray([]); //list of presets
	self.preset = ko.observable(); //selected preset object
	self.preset.subscribe(function(){ self.loadPreset(); }); //activate new selected preset
	self.preset.edit = ko.observable(); //add preset mode
	self.preset.newname = ko.observable(); //new preset name
	self.preset.status = ko.observable(''); //self-clearing status text
	self.preset.status.subscribe(function(txt){if(txt) setTimeout(function(){ self.preset.status(''); }, 3000);});
	self.options = {}; //datamodel for tracking input values
};

//construcor for creating plugin interface
Pline.plugin.prototype = {
	//add plugin interface to the webpage
	draw: function(targetEl, clone){ //targetEl(optional) = plugin interface container
		var plugin = this;
		var UItarget = plugin.UIcontainer = $(targetEl||Pline.settings.UIcontainer);
		if(!$(UItarget).length){
			plugin.showError('Plugin.draw() error: container element not found: '+UItarget);
			return;
		}
		if(targetEl) Pline.settings.UIcontainer = targetEl;
		Pline.submitted(false);
		
		//plugins html container
		var footerUI, btnUI;
		if(!$(".pline", UItarget).length){ //first plugin draw. Make the container.
			Pline.clearPipeline(); //clear any previous plugins
			UItarget.append('<div class="pline"><div class="pl-plugins"></div></div>');
			
			//footer elements
			footerUI = $('<div class="pl-footerdiv">');
			btnUI = $('<div class="pl-btndiv"><hr></div>');
			
			//email notification interface
			if(Pline.settings.sendmail){ 
				var emailUI = '<div class="pl-email" data-bind="visible:'+
				(typeof(Pline.settings.sendmail) == 'string'? 'Pline.pipeline().length>1' : 'Pline.settings.email') + '">'+
				'<span class="pl-label" title="Fill in your email address to send a notification after the submitted job has finished running.">'+
				'Notify me when done:</span> <input data-bind="value: Pline.settings.email || \'\'" placeholder="Email address" style="width:120px"></div>';
				footerUI.append(emailUI);
			}
			
			//configuration file load/save interface
			if(Pline.settings.presets){
				var configUI = '<div class="pl-config" data-bind="visible: Pline.config.edit"><hr>'+
					'<input type="text" data-bind="value: Pline.config.name" placeholder="Pipeline name"></input>'+
					'<a class="pl-button pl-small pl-square" onclick="Pline.saveConfig()" title="Store the current pipeline to a file">Save</a>'+
					'<a class="pl-button pl-small pl-round pl-red" title="Cancel" onclick="Pline.config.edit(false)">x</a><br>'+
					'<input type="text" class="desc" data-bind="value: Pline.config.desc" placeholder="Description (optional)"></input>'+
				'</div>'+
				'<!-- ko if: Pline.config.errors().length --><div class="pl-errormsg">Errors: '+
					'<span class="pl-icon pl-action pl-close" title="Close the messages" onclick="Pline.config.errors.removeAll()">ⓧ</span>'+
					'<ul data-bind="foreach: Pline.config.errors"><li data-bind="text: $data"></li></ul></div><!-- /ko -->'+
				'<div class="pl-config pl-message" data-bind="text: Pline.config.message, fadevisible: Pline.config.message"></div>';
				var configFileInput = $('<input class="pl-fileinput" type="file" accept=".json" style="display:none" onchange="Pline.readConfig(this.files)">');
			
				footerUI.append(configUI, configFileInput);
				var configBtn = $('<a class="pl-button" title="Open or store a pipeline file">Import | Export</a>');
				var configMenu = [
					{text: 'Import pipeline', title: 'Restore a pipelne from a JSON file', click: function(){ configFileInput.click(); }},
					{text: 'Export pipeline', title: 'Save the current pipelne to a JSON file', click: function(){ Pline.config.edit(true); }}
				];
				configBtn.click(function(){ Pline.makeMenu(configBtn, configMenu, 'bottom'); });
				btnUI.append(configBtn);
			}
			//pipeline building button
			if(Pline.settings.pipelines){
				btnUI.append('<a class="pl-button" onclick="Pline.makeMenu(this, \'\',  \'bottom\')" '+
				'title="Add a pipeline step">Add step</a>');
			}
			//submit button
			var submitbtn = $('<input type="submit" class="pl-button pl-submit" data-bind="value: Pline.sBtn().text, attr:{title: Pline.sBtn().title}">');
			submitbtn.click(plugin.submitJob.bind(plugin));
			btnUI.append(submitbtn);
			$('.pline', UItarget).append(footerUI, btnUI);
		}
			
		var container = $(".pl-plugins", UItarget).last();
		
		if(plugin.xhr){ //JSON not yet fetched
			var errspan = plugin.showError('Plugin not yet ready', 'downloading the JSON...');
			plugin.xhr.done(function(){ errspan.remove(); plugin.draw(UItarget); });
			return plugin;
		}
		
		//existing plugin interfaces found in the container
		if($('.pl-plugin', container).length){
			if(Pline.settings.pipelines){ //add as a pipeline step
				plugin = plugin.addPluginStep(); //returns cloned plugin
			} else { //replace interface with the new plugin
				Pline.clearPipeline();
			} 
		} else if(clone){ //use a plugin duplicate
			plugin = plugin.clonePlugin();
		}

		Pline.pipeline.push(plugin.id);
		
		//add plugin interface
		pluginUI = plugin.renderUI();
		container.append(pluginUI);
		
		//bind the interface to its datamodel
		try{
			ko.applyBindings(plugin, pluginUI[0]);
			if(footerUI) ko.applyBindings(plugin, footerUI[0]);
			if(btnUI) ko.applyBindings(plugin, btnUI[0]);
		}catch(e){
			plugin.showError('Plugin error when wiring up the interface', e);
		}
		
		return plugin;
	},
	
	//add the plugin as an additional interface (pipeline step)
	addPluginStep: function(){
		var step1_div = $('#'+Pline.pipeline()[0]);
		if(!step1_div.hasClass('pl-pluginstep')){ //wrap the first plugin div as pipeline step
			step1_div.addClass('pl-pluginstep').wrapInner('<div class="pl-insidediv"></div>').prepend('<span class="pl-nr">1</span>',
			Pline.makeSection({title:Pline.plugins[Pline.pipeline()[0]].title, desc:'Click to toggle plugin options', keepw:true, inline:true}));
		}
		$('.pl-pluginstep > .pl-insidediv').slideUp().siblings().children('.pl-rotateable').removeClass('pl-rotateddown'); //collapse all previous steps
		return this.clonePlugin();
	},

	//returns independent copy of the plugin instance
	clonePlugin: function(){
		var stepnr = Pline.pipeline().length;
		return Pline.addPlugin(
			new Pline.plugin( JSON.parse(JSON.stringify(this.json)), //clone current data
				{id: this.id+stepnr, path: this.path, step: stepnr, duplicate: this.id} //modifications
			),
			this.path
		);
	},
	
	//remove the last pipeline step
	removePluginStep: function(){
		if(Pline.pipeline().length < 2) return;
		var stepname = Pline.pipeline.pop();
		$('#'+stepname, this.UIcontainer).remove();
		delete Pline.plugins[stepname]; //remove duplicated plugin
	},
	
	//store a new preset (set of current plugin input values)
	addPreset: function(){
		var self = this;
		if(!self.preset.edit()){ self.preset.edit(true); return; } //go to 'add preset' mode
		if(!self.preset.newname()){ self.preset.status('Please type a name for the new preset.'); return; }
		var newpreset = {name:self.preset.newname(), preset:self.readInputs()};
		self.presets.push(newpreset);
		self.preset(newpreset); //mark as active preset
		self.preset.edit(false);
		self.preset.newname('');
		self.editStorage(self.id+'_presets', self.presets()); //save all presets to localStorage
		self.preset.status('Input values saved.');
		return newpreset;
	},
	
	//get current values of option observables (read user input)
	readInputs: function(){
		var self = this;
		var ovalues = {};
		for(var oname in self.options){ //get values of all plugin option observables
			var opt = self.options[oname];
			if(!('peek' in opt)) continue; //skip non-observables
			var optval = opt();
			//store filenames in fileinputs (for local files)
			if(Pline.config.includeFiles && opt.container && opt.container().length){
				if(!ovalues._files_) ovalues._files_ = {};
				ovalues._files_[oname] = optval;
			}
			if('hasWriteFunction' in opt) continue; //skip computed observables
			if((opt.otype=='text' || opt.otype=='hidden' || !opt.defaultval) && !optval) continue; //empty input
			if(opt.defaultval && optval == opt.defaultval) continue; //filled with default value
			ovalues[oname] = optval; //store input value
		}
		return ovalues;
	},
	
	//remove a preset
	removePreset: function(){
		var self = this;
		self.presets.remove(self.preset());
		self.editStorage(self.id+'_presets', self.presets()); //update localStorage
		self.preset.status('Preset removed.');
	},
	
	//read in a stored preset
	restorePreset: function(preset, activate){
		var self = this;
		self.presets.remove(function(item){ return item.name == preset.name; }); //remove any duplicates
		self.presets.push(preset);
		if(activate) self.preset(preset); //=>loadPreset	
	},
	
	//apply a preset
	loadPreset: function(data, quiet){
		var self = this;
		if(!data) data = self.preset(); //preset obj: {name:presetName, preset:{obsName:val,...}}
		if(self.preset.edit() || !data) return;
		if(!data.preset){ Pline.config.errors.push('No preset data!'); return; }
		if(data.preset._files_){
			data.files = data.preset._files_;
			delete data.preset._files_;
		}
		for(var optname in data.preset){ //restore option values from a preset
			if(!self.options[optname]){
				self.error('Cannot restore option value: option "'+optname+'" is missing from the plugin!', 'warning'); 
			} else { self.options[optname](data.preset[optname]); }
		}
		if(data.files && data.URL){ //restore input files (from remote source)
			$.each(data.files, function(optname, filename){
				if(self.options[optname] && self.options[optname].container){
					$.get(data.URL+filename).done( function(filedata){
						var file = new Blob([filedata]);
						file.name = filename;
						self.options[optname].container([file]);
					});
				}
			});
		}
		if(!quiet) self.preset.status('Input values restored.');
	},
	
	//read/write presets to localStorage
	editStorage: function(key, data){
		//check availability (e.g. private window)
		try{
			var s = window.localStorage;
			s.setItem('tmp','tmp');
			s.removeItem('tmp');
		}
		catch(e){ return false; }
		//store/retrieve items
		if(key && typeof(data)!='undefined'){ //write
			if(data===null) s.removeItem(key);
			else s.setItem(key, JSON.stringify(data));
		} else if(key){ //read
			try{ return JSON.parse(s.getItem(key)); }catch(e){ return; }
		}
		return true;
	},
	
	//API error feedback
	error: function(errtxt, iswarning){
		if(this.curopt) errtxt = errtxt+' (when parsing option "'+this.curopt+'")';
		if(!this.ready && !iswarning) this.errors.push(errtxt);
		console[iswarning?'log':'error']('%c '+this.title+' %c '+errtxt, 'color:white;background-color:orange;border-radius:3px', '');
		return '';
	},
	
	//display an error message in the interface
	showError: function(title, msg){
		if(!title) title = 'Plugin error for '+this.title;
		title += ':';
		
		if(msg){
			this.error(msg);
		}
		else{
			if(!this.errors.length) return false;
			msg = '<ul><li>'+this.errors.join('</li><li>')+'</li></ul>';
			title += '<br>';
			this.errors = [];
		}
		
		var container = $(".pl-plugins", this.UIcontainer);
		if(!container.length) return false;
		var errspan = $('<p class="pl-error">'+title+' '+msg+'</span>');
		container.append(errspan);
		return errspan;	
	},

	//display a message on the submit button
	btnText: function(msg){
		if(!msg) return;
		var btn = $(".pl-submit", this.UIcontainer)[0]||'';
		if(btn){
			btn.value = msg;
			clearTimeout(this.btn_to);
			this.btn_to = setTimeout(function(){
				btn.value = Pline.sBtn().text;
			}, 2000); //clear msg after 2sec.
		}
	},
		
	//log debug messages
	log: function(logtxt, opt){
		if(!this.debug) return;
		if(typeof(opt)=='string') opt = {name:opt};
		else if(!opt) opt = {};
		var optname = opt.name||this.curopt||'';
		if(typeof(this.debug)=='string' && this.debug!=optname) return;
		var logargs = [];
		if(optname){ //add plugin option name
			logtxt = '%c '+optname+' %c '+logtxt;
			logargs.push('color:white;background-color:#888;border-radius:3px');
		}
		if(opt.title){ //add plugin name
			logtxt = '%c '+this.title+(optname?' %c ':' %c %c ')+logtxt;
			logargs.unshift('color:white;background-color:orange;border-radius:3px','');
		}
		if(optname||opt.title) logargs.push(''); //reset message color
		if(opt.obj){ logtxt += ' %o'; logargs.push(opt.obj); } //add object data
		logargs.unshift(logtxt); //add debug message
		console.log.apply(null, logargs); //print out
	},
	
	//find option-bound observables
	getOption: function(optname){
		if(optname in this.options) return this.options[optname];
		for(var trackname in this.options){ if(this.options[trackname].option && this.options[trackname].option == optname) return this.options[trackname]; }
		this.log('getOption(): option "'+optname+'" not found');
		return false;
	},
	
	// -- Plugin JSON data parser functions -- //
	//parse the conditional API keywords to Javascript (observables/logic/quoted text)
	parseToken: function(expr){
		var self = this;
		var inputexpr = expr;
		//detect a tracked option (observable from datamodel). Returns: HTML (for data-bind)
		var obsStr = function(name){
			if(!name) return '';
			var names = name.split('.'); //include subvariables (observable.observable())
			var kostr = typeof(self.options[names[0]])=='function'? "$data.options['"+names[0]+"']" : '';
			if(!kostr) return '';
			if(names.length > 1) kostr += typeof(self.options[names[0]][names[1]])=='function'? "['"+names[1]+"']()" : '()';
			//else if(self.options[name].otype=='text' && self.options[name].defaultval){ //consider the default value
			//	kostr = "("+kostr+"()||$data.options['"+name+"'].defaultval)"; 
			//}
			else kostr += '()';
			//if(!self.ready) self.log('condition/value is using tracked name "'+name+'"');
			return kostr;
		};
		var quote  = function(exp){ //returns: "number"|"boolean"|"'quoted string'"
			try{ JSON.parse(exp); }catch(e){ return "'"+exp+"'" }; return exp;
		}
		//API keywords
		var apiDict1 = {' is not ':'!=', ' is equal to ':'==', ' is less than ':'<', ' is more than ':'>', ' is disabled':'.disabled()',
			' is enabled':'.disabled()==false'};
		var apiDict2 = {'is':'==',  'equals':'==', 'contains':'.includes(', 'not':'!', 'no':'!', 'invert':'!', 'off':'false', 'yes':'true', 
			'on':'true', 'ticked':'true', 'checked':'true', 'selected':'true', 'and':'&&', 'or':'||', 'type':'.datatype',
			'disabled':'.disabled()', 'enabled':'.disabled()==false', 'disable':'false', 'this':self.curopt};
		if(typeof(expr)=='string'){
			expr = expr.trim(); //remove space padding
			if(expr=='undefined') return "";
			if(!expr.includes(' ')){ //parse single word
				return expr.charAt(0)=="'"?quote(expr.replace(/'/g,'')):(apiDict2[expr]||obsStr(expr)||quote(expr));
			}
			//parse: 1)quoted text 2)spaced api words 3)api words
			var tokenizer = new RegExp('".+"|\'.+\'|'+Object.keys(apiDict1).join('|')+'|[\\w\\-]+','g');
			expr = expr.replace(tokenizer,  function(word){
				if(word.charAt(0)=='"' || word.charAt(0)=="'"){ //quoted text (no translation)
					return word.replace(/"/g,"'");
				} else {  return (apiDict1[word]||apiDict2[word]||word); }
			});
			expr = expr.replace(/ (\.)/g, "$1").replace(/(!) /g, "$1"); //close gaps
			//parse: 4)observable names 4)values/words
			expr = expr.replace(/'.+'|[\w\-\.]+/g,  function(word){
				if(word.charAt(0)!="'"){ return (obsStr(word)||quote(word)); }
				else{ return word; }
			});
			expr = expr.replace(/' '/g, " "); //join quoted words
			expr = expr.replace(/\.includes\(\w+/g, '$&)'); //close includes() parentheses
			//if(!self.ready && inputexpr!=expr) self.log('parseToken: '+inputexpr+' => '+expr);
			return expr;
		} else { return typeof(expr)=='undefined'? "" : JSON.stringify(expr); } //stringify numbers/booleans
	},

	//convert plugin API conditionals to Javascript conditionals (input/output: string)
	parseRule: function(rule, result, rootvar){ //('conditional','resultValue'[,'parentObservable'])
		if(typeof(result)=='undefined') result = "true";
		var str = "";
		
		if(Array.isArray(rule)){ //[rule1, rule2, ...] => apply sequentially
			for(var i=0, tmp=''; i<rule.length; i++){
				tmp = this.parseRule(rule[i], result, rootvar);
				if(i<rule.length-1) tmp = tmp.split(":")[0]+":";
				str += tmp;
			}
		}
		else if(typeof(rule) == 'object'){ //unpack rule objects
			if(Object.keys(rule).length>1){ //{rule1:res1, rule2:res2} => [{rule1:res1}, {rule2:res2}]
				var ruleArr = [];
				$.each(rule, function(subrule, subresult){
					var ruleObj = {};
					ruleObj[subrule] = subresult;
					ruleArr.push(ruleObj);
				});
				str = this.parseRule(ruleArr, result, rootvar);
			} else {  //{'rule': result}
				varname = Object.keys(rule)[0];
				varresult = rule[varname];  //if {"varname":{varval:result}} else {"varname":result}
				if(typeof(varresult) == 'object') str = this.parseRule(varresult, result, varname);
				else str = this.parseRule(varname, varresult, rootvar);
			}
		}
		else{  //parse a rule
			if(typeof(rule) == 'number'){
				try{ 
					return JSON.parse(rule);
				}catch(e){
					self.error('parseRule("'+rule+'") => '+e);
					return ""; 
				}
			} else if(typeof(rule) != 'string'){
				return JSON.stringify(rule);
			}
			rule = this.parseToken(rule); //conditional
			result = this.parseToken(result); //result value
			rootvar = this.parseToken(rootvar); //current observable
							
			var compare = function(rule){ //add '==' if needed (rule = rootvarValue)
				return ~["!","=","<",">","~","."].indexOf(rule.charAt(0))? rule: "=="+rule;
			}
			str = rootvar? rootvar + compare(rule) : rule; //apply rule to current option value
			var endresult = (!result||result=="true")? "false" : result=="false"? "true" : "\'\'";
			if(result!=="true" || rootvar) str += "?" + result + ":" + endresult;
		}
		return str;
	},
	
	//API conditional (string) => JS conditional (string) => function
	ruleToFunc: function(rule, appendstr){
		var funcstr = this.parseRule(rule); //JSON rule => JS expression
		if(typeof(funcstr) == 'string'){
			funcstr = funcstr.replace(/\$data/g,"this").replace(/\w+\(\)/g, "this.$&")+(appendstr||'');
		}
		try{
			var rfunc = new Function("return "+funcstr);
		}catch(e){
			return this.error("Faulty rule function ("+e+"): "+rule+" => "+funcstr);
		}
		this.log('Parsed rule function: '+funcstr);
		return rfunc.bind(this);		
	},
	
	//generate variable name (for an observable)
	makeName: function(){
		var namecount = Object.keys(this.options).filter(function(oname){ return oname.indexOf('trackName')==0; }).length;
		return 'trackName'+(namecount+1);	
	},
	
	//parse a single plugin option data object
	parseOption: function(data, parentArr, obs){
		var self = this;
		
		if(typeof(data)!='object' || data.info) return true; //text or icon (no parsing needed)
		if(!Object.keys(data).length){ //empty option object
			self.error('empty option: '+data,'warning');
			var optind = parentArr.indexOf(data);
			if(~optind) parentArr.splice(optind, 1); //remove faulty option data
			return false;
		}
								
		//valid option/input types
		var types = {"text":"", "string":"text", "number":"text", "int":"text", "float":"text", "bool":"checkbox", 
			"tickbox":"checkbox", "checkbox":"", "hidden":"", "select":"", "file":"hidden"};
		
		//parse {optType:optName} shorthand syntax
		for(var k in data){
			if(k in types){
				if(!data.type) data.type = k; //fill in "type"
				var optname = typeof(data[k])=='string'? data[k] : '';
				if(!("title" in data) && k!="file") data.title = optname; //fill in "title"
				if(!("option" in data) && k!='select'){ //fill in "option"
					if(optname && (/[^a-zA-Z0-9_+-]/).test(optname)){ //optname contains strange chars
						self.log('Cannot set "'+optname+'" as program argument name (you can use "name" attribute instead).');
					} else data.option = optname; //valid argument name (or empty for positional arg.)
				}
			}
		}
				
		if(!("option" in data) && !data.name && !data.selection){
			self.log('Dummy input: no name or option defined => '+JSON.stringify(data));
		}
		
		if(!data.type || !(data.type in types)) data.type = "text"; //default type
		var otype = types[data.type] || data.type; //input element type (text|checkbox|hidden|select)
		
		//delegated option (proxy input => value parsing => option value)
		var valuebool = otype=='checkbox' && data.value;  //checkbox with a value conversion
		//values merged over multiple inputs
		var valuemerge = false;
		if("merge" in data){ //merged input values
			if(data.merge === true) data.merge = ','; //default merged value separator
			if(typeof(data.merge) == 'string'){
				//merged options use both "option" (for the arg value) and "name" (for the inputs)
				if(!data.option) self.log('Error: input merging needs argument name ("option" attr)!');
				else if(data.type == 'file') self.log('Cannot merge file input values ("merge" attr ignored).')
				else if(!data.addedOption) valuemerge = true;
			}
			if(!valuemerge) delete data.merge;
			else if(data.option == data.name){
				self.log('Note: "option" and "name" needs to be different for input merging.');
				delete data.name; //will be renamed
			}
		}
		
		if(data.option && !data.prefix){ //set parameter value prefix
			var inline = data.option.match(/^\W+/);
			if(inline && inline.length){ //prefix in the option name
				data.option = data.option.replace(inline[0], '');
				data.prefix = inline[0];
			} else data.prefix = self.prefix; //default: global prefix ("-")
		}
		
		//option name and value tracking
		if(!data.name){  //register tracking variable name
			data.name = data.option && !valuemerge? data.option : self.makeName();
		}
		
		var trackname = self.curopt = data.name; //aliases
		if(!(trackname in self.options)){ //set up observable for tracking input value changes
			if(typeof(obs) == "function"){ //premade computed observable
				self.options[trackname] = obs;
			} else {
				self.options[trackname] = ko.observable(obs||'');
			}
		} else { //option already registered (duplicate "name" in JSON)
			self.log('Duplicate option ("name" attribute) already parsed. Skipping.');
			return true;
		}
		var trackvar = self.options[trackname];
		
		self.log('Parsing '+data.type+("option" in data? ' option '+data.option : ' input'));
		
		//delegated checkbox (checkbox => formatted value)
		if(valuebool){
			if(!Array.isArray(data.value)) data.value = [data.value]; //checkbox data.value:[checkedVal, uncheckedVal]
			if(data.value[0]!==true && data.value[0]!==false) data.value[0] += ''; //convert to string
			if(data.value.length<2) data.value[1] = false;
			else if(data.value[1]!==true && data.value[1]!==false) data.value[1] += '';
			if(typeof(data.default)=='undefined') data.default = data.value[1];
			else if(data.default!==true && data.default!==false){ data.default += ''; }
			if(!data.value.includes(data.default)) self.error('The default checkbox state ('+data.default+') not in the list of its values: '+data.value, 'w');
			//add the proxy checkbox input
			var cbname = trackname+'_checkbox';
			if(!~Pline.indexOfObj(parentArr, 'name', cbname)){ //add the checkbox element to json
				var cbdata = Object.assign({}, data, {name:cbname, default:data.default===data.value[0], proxyInput:true}); //use current data
				delete cbdata.value; delete cbdata.merge;
				var opti = Pline.indexOfObj(parentArr, 'name', data.name)+1;
				parentArr.splice(opti, 0, cbdata); //place after the current option (parsed by next parseOption() loop)
				self.parseOption(cbdata, parentArr); //make observable
			}
			//turn the original option to the converted value holder from the proxy checkbox
			trackvar = self.options[trackname] = ko.pureComputed({
				read: function(){ //tickbox => formatted value (argname=val)
					return self.options[cbname]()?data.value[0]:data.value[1];
				},
				write: function(val){ //option value => un/check tickbox
					val===data.value[0]?self.options[cbname](true):self.options[cbname](false);
				}
			});
			otype = data.type = 'hidden';
			self.log('Using proxy checkbox: '+cbname);
		}
		
		if(!trackvar.otype) trackvar.otype = otype;
		
		//auto-format numerical text input
		if(~["number","float","int"].indexOf(data.type)){
			trackvar.extend({format: data.type});
		}
		
		//hidden options
		if(data.type == "hidden"){
			if(!("default" in data)){ //.value == .default
				if("value" in data && !valuebool) data.default = data.value
				else if(!data.addedOption) data.default = true; //add missing value attr
			}
		}

		//option defines an output filename
		if(data.outfile){
			if(!self.outfileopt) self.outfileopt = [];
			self.outfileopt.push(data.outfile===true? trackname : data.outfile);
		}
		
		var delegated = valuemerge||valuebool; //option uses proxy input
		
		//link option to its program argument
		if("option" in data){
			if(data.option.length){ //named argument
				if(!("argname" in trackvar)){ //register argument name
					if(data.option.includes(' ')) self.error('Space found in option name: "'+data.option+'"');
					trackvar.argname = data.prefix+data.option; //links argname to input element (for input title attr)
					if(data.title==data.option) data.title = trackvar.argname; //add prefix to the displayed option name
					if(!delegated) trackvar.optname = data.option; //links argname to its observable (for getOption())
					if(valuemerge){ //add to the list of inputs that will merge its values to the target option (program argument)
						self.log('Adding to the list of merged inputs for option '+data.option);
						data.proxyInput = true;
						if(!self.mergeopt) self.mergeopt = {};
						if(!self.mergeopt[data.option]) self.mergeopt[data.option] = {tnames:[trackname], valuesep:data.merge};
						else self.mergeopt[data.option].tnames.push(trackname);
					}
				}
			}
			data.argname = trackvar.argname || '';
			if(data.order) trackvar.argpos = data.order;
		}
		
		if("default" in data){ //set conditional default value (via custom binding)
			self.log('Default option value: '+(JSON.stringify(data.default)));
			trackvar.defaultval = self.ruleToFunc(data.default)(); //evaluate initial value
		}
				
		if(data.type == "file"){ //split observable to filename parser + value trackers
			var pipeline = self.step; //the plugin is (2nd or later) step in a pipeline
			if(!"option" in data) self.error('Please provide the "option" attribute for the input file', 'warning');
			if(!data.desc) data.desc = 'Give an input file for the '+(data.required?'required':'optional')+' program argument '+(data.argname||'');
			
			self.options[trackname] = trackvar = ko.computed({
				read: function(){ //returns file source (filename/filepath/pipe)
					var trackname = data.name;
					if(self.pipe().length && ~self.pipe.indexOf(trackname)) return '_pipe_';
					var fpath = self.options[trackname].filepath();
					var fname = self.options[trackname].filename();
					return fname? fpath+fname : fname; //[../]filename.ext || ''
				},
				write: function(fname){ //parse a filename candidate
					var trackname = data.name;
					var trackvar = self.options[trackname];

					if(typeof(fname) != 'string') fname = '';
					fname = fname.replace(/^\W+/, '');

					if(fname && !trackvar.filepath()){ //user-supplied file
						if(trackvar.defaultval && typeof(trackvar.defaultval) == 'string'){
							fname = trackvar.defaultval; //filename is fixed in plugin json
						}
						//check for a filename clash wiht another input
						var splitind = fname.includes('.')? fname.lastIndexOf('.') : fname.length;
						var label = fname.substring(0, splitind).replace(/ /g,'_');
						var ext = fname.substring(splitind);
						if(label.length){
							var nr = parseInt(label.charAt(label.length-1));
							if(nr) label = label.substring(0, label.length-1);
							else nr = 1; //filename suffix
							for(var opt in self.options){
								var fname2 = self.options[opt].filename? self.options[opt].filename() : false;
								if(fname2 && opt != trackname && !self.options[opt].filepath() && fname == fname2){
									fname = label+(++nr)+ext; //duplicate: rename
								}
							}
						}
					}
					trackvar.filename(fname);
				},
				deferEvaluation: true
			});
			//(re)bind metadata
			trackvar.otype = 'hidden';
			trackvar.filepath = ko.observable(pipeline? '../' : '');
			trackvar.filename = ko.observable('');
			trackvar.rootname = ko.pureComputed(function(){
				return trackvar.filename().split('.')[0];
			});
			trackvar.argname = data.argname;
			trackvar.defaultval = data.default || data.value || '';
			trackvar.argpos = data.order || '';

			//pipeline step: select filenames from the previous step
			if(pipeline){
				//filename selection tracker
				var selname = trackname+'_sel';
				//build filename selection
				var seldata = {title: data.title||'Input file:', type:'select', name:selname, fileinput:trackname, desc:data.desc};
				['enable','disable','required','check'].forEach(function(attr){ if(data[attr]) seldata[attr] = data[attr]; });
				//add output filenames from the previous pipeline step
				var previd = Pline.pipeline()[self.step-1];
				var prev = Pline.plugins[previd];
				var fromprev = 'from the previous pipeline step.';
				var selection = [];
				if(typeof(data.required) != 'string'){ //allow empty fileinput
					selection.push({title: 'None', value: '', desc: 'This input file is optional', default: true});
				}
				selection.push({title: 'Previous step output:', value: '_title1_', desc: 'Use an output '+fromprev});
				//add registered output files from the previous step
				prev.outFiles.forEach( function(fname, i){
					selection.push( 
						{title: '• '+fname(), value: fname, show: fname, desc: 'Use this file '+fromprev} 
					);
				});
				selection.push({ title: '• standard output', value: prev.stdout, default: data.required,
					desc: 'Use the stored standard output ('+ prev.stdout() +') '+ fromprev
				});
				selection.push({title: '• pipe', value: '_pipe_', desc: 'Use the standard output as piped datastream '+fromprev});
				selection.push({title: '• filename ⟶', value: '_custom_', desc: 'Specify a filename or filepath '+fromprev});
				//add previous step fileinputs
				var filelist = [];
				for(var optname in prev.options){
					if(prev.options[optname].container){
						fileopt = prev.options[optname];
						var optinfo = fileopt.argname? 'option '+fileopt.argname : 'positional argument';
						//dynamically include filled fileinputs from the previous step
						filelist.push({title: fileopt, value: fileopt, show: fileopt.rootname,
							desc: 'Used by '+optinfo+' in the previous pipeline step.'});
					}
				}
				if(filelist.length){
					selection.push({title: 'Previous step input:', value: '_title2_', desc: 'Select an input file '+fromprev});
					selection = selection.concat(filelist)
				}
				//add filedrop option
				selection.push({title: 'Local file ⟶', value: '_local_', desc: 'Use a file from your computer.'});
				seldata.selection = selection;
				//add the selection data to the plugin json
				var optind = Pline.indexOfObj(parentArr, 'name', data.name);
				parentArr.splice(optind, 0, seldata); //place the selection element in front of the fileinput
				self.parseOption(seldata, parentArr); //parse & register the observable
				
				//track updates: selection value => filename value
				self.options[selname].subscribe(function(val){
					var trackvar = self.options[data.name]; //rescope trackvar
					if(val == '_local_'){ //user file
						trackvar.filepath(''); 
					} else { //server-side file
						trackvar.filepath('../');
						if(trackvar.container().length) trackvar.container([]);
					}
					//keep track of inputs using pipes
					if(val == '_pipe_'){
						self.pipe.push(trackname);
					} else{ 
						self.pipe.remove(trackname);
					}
					//set filename (from selection or from other input)
					if(~['_custom_','_local_','_pipe_','_title1_','_title2_'].indexOf(val)) val = '';
					self.log('Filename from selection: '+val, selname);
					trackvar(val);
				});
				self.options[selname].valueHasMutated(); //sync selection => filename
			} else {
				self.log('First pipeline step: resetting filename', trackname);
				trackvar('');
			}
			
			//container for file content
			trackvar.container = ko.observableArray(); //File Object cointainer
			trackvar.container.subscribe(function(filearr){ //filedrop=>update filename
				self.log('Got '+filearr.length+' file(s) from filedrop', trackname);
				if(filearr.length) trackvar(filearr[0].name||'input_file.txt');
				else trackvar('');
			});
		}//if file
		
		
		//build a selection list of options/values
		if(otype == "select"){
			if(!Array.isArray(data.selection)){ self.error('"select" option needs the "selection" array'); data.selection = []; }
			var selarr = trackname+"_selection";
			//parse selection items from JSON
			self.options[selarr] = []; //list of selection items
			trackvar.syncopts = {};

			for(var sindex in data.selection){ //parse selection list items
				var seldata = data.selection[sindex]; //input: data for the list item
				var selitem = {t:'', v:'', d:''}; //output: parsed list item
				if(typeof(seldata)=='string' || typeof(seldata)=='number'){ //item is string/number
					selitem.t = selitem.v = seldata;
					if(selitem.v==='' && !("defaultval" in trackvar)) trackvar.defaultval = '';
				} 
				else if(typeof(seldata)=='object'){ //parse item object
					//fill in missing item attributes: "default"/"option"=>"title"=>"value"
					var optval = typeof(seldata.option)=="string"? seldata.option : '';
					var defval = typeof(seldata.default)=="string" || typeof(seldata.default)=="number"? seldata.default : '';
					if(!("title" in seldata)) seldata.title = defval || optval || '';
					else if(typeof(seldata.title)=='object'){
						self.error('selection item "title" needs to be a string (not object)');
						continue;
					}
					if(!("value" in seldata)) seldata.value = seldata.title;
					else if(typeof(seldata.value)=='object'){
						self.error('selection item "value" needs to be a string (not object)');
						continue;
					}
					selitem.t = seldata.title;
					selitem.v = seldata.value; 
					if(typeof(seldata.desc)=='string') selitem.d = seldata.desc; //list item description
					//choose initially selected item
					if(seldata.default) trackvar.defaultval = selitem.v;
					else if(selitem.v === '' && !("defaultval" in trackvar)) trackvar.defaultval = '';
					//dynamically hidden selection item
					if(seldata.hide || seldata.show){
						selitem.hide = ko.pureComputed(function(){
							var rule = this.hide || this.show;
							var ruleFunc = typeof(rule) == 'function'? rule : self.ruleToFunc(rule);
							var isHidden = ruleFunc();
							return this.hide? isHidden : !(isHidden);
						}, seldata);
						trackvar.addrule = true;
					}
					//register other options set by this selection input
					if(seldata.option){
						if(!selitem.opt) selitem.opt = {};
						if(!Array.isArray(seldata.option)) seldata.option = [seldata.option];
						for(var optindex in seldata.option){ //import options in the "option" attr
							var opt_data = seldata.option[optindex];
							if(typeof(opt_data)=='string'){ selitem.opt[opt_data] = true; } //enables a boolean option
							else if(typeof(opt_data)=='object'){ $.extend(selitem.opt, opt_data); } //sets a value for an option
							else{
								self.error('options in the selection item "option" attribute need to be strings or objects');
								continue;
							}
						}
						//register the options set by this selection
						if(!self.selopt[trackname]) self.selopt[trackname] = {};
						for(optname in selitem.opt){
							trackvar.syncopts[optname] = ''; //list of linked options for this selection
							self.selopt[trackname][optname] = ''; //all selection-linked options => registered in finishOption()
						}
					}	
				}else{ self.error('selection item needs to be string, number or object'); }
				
				//add the selection item to the selection list
				self.options[selarr].push(selitem);
			} //foreach selection item
			self.log('Parsed selection list: ', {obj:self.options[selarr]});
			
			//set initial selection
			if(!("defaultval" in trackvar)) self.options[selarr].unshift({t:data.caption||"Select...", v:""});
			else{
				self.log('Setting default selection: '+trackvar.defaultval);
				trackvar(trackvar.defaultval);
			}
			
			if(Object.keys(trackvar.syncopts).length) self.log('Found linked options: '+Object.keys(trackvar.syncopts));
			else trackvar.syncopts = false;
			
			//track the selected list item => change any linked options/description
			trackvar.desc = ko.observable('');
			trackvar.restoreopt = {};
			trackvar.sindex = ko.computed(function(){
				var trackvar = self.options[data.name];
				var selectedval = trackvar();
				//self.log('selection "'+trackname+'" was changed to "'+selectedval+'"');
				var selectedind = Pline.indexOfObj(self.options[selarr], 'v', selectedval);
				if(selectedind < 0) return selectedind; //selection not ready
				var selecteditem = self.options[selarr][selectedind];
				trackvar.desc(selecteditem.d); //set item description
				if(trackvar._locked) return selectedind; //selection was changed by linked options
				trackvar._locked = true; //prevent selection=>options=>selection loop
				if(Object.keys(trackvar.restoreopt).length){ //restore the option values set by the previous selection
					self.log('Selection changed. Restoring previous options: '+JSON.stringify(trackvar.restoreopt), data.name);
					$.each(trackvar.restoreopt, function(optname, optv){
						self.getOption(optname)(optv);
					});
					trackvar.restoreopt = {};
				}
				//set values of linked options
				if(selecteditem.opt){
				  $.each(selecteditem.opt, function(optname, newval){
						self.log('Selection is changing option: "'+optname+'" => '+newval, trackname);
						var optobs = self.getOption(optname);
						if(!optobs){ //unregistered option. register & set its value in finishOption().
							self.selopt[trackname][optname] = newval;
							self.log('Postponing for second pass: "'+optname+'" = '+newval, trackname);
						} else {
							trackvar.restoreopt[optname] = optobs.peek(); //store option original value
							optobs(newval); //change linked option value
						}
				  });
				}
				setTimeout(function(){ trackvar._locked = false; }, 100); //lock release
				return selectedind; //index of the selected item
			});
			
			//set up dynamically hidden selection items
			if(trackvar.addrule === true){ //bind to selection item DOM elements
				trackvar.addrule = function(itemElem, selitem){
					if(selitem.hide) ko.applyBindingsToNode(itemElem, {hidden: selitem.hide});
				}
			}
			if("multi" in data){ //merge multiple-selection values
				var valuesep = typeof(data.multi=='string')? data.multi : ',';
				trackvar.selectedarr = ko.observableArray([trackvar()]);
				trackvar.selectedarr.subscribe(function(newarr){ trackvar(newarr.join(valuesep)); });
			}
		}//if select

		//log input value changes
		if(self.debug){
			trackvar.subscribe(function(newval) {
				self.log(trackvar.otype+' input value: '+JSON.stringify(newval), {name:trackname, title:true});
			});
		}
		return true;
	}, //parseOption
	
	//2nd parsing pass: add proxy options & register dependencies
	finishOption: function(data, parentArr){ //ran for each option in JSON
		if(typeof(data)!='object' || data.info) return true; //text or icon (no parsing needed)
		
		var self = this;
		var trackname = self.curopt = data.name;
		//adds, rewrites or updates an option (for holding an argment value)
		var addOption = function(optname, optval){
			if(!(optname in self.options)){ //option not in json (not registered in the previous parsing round)
				self.log('Adding '+optname+' as hidden option');
				var odata = {hidden: optname, name: optname, value: optval, addedOption:true};
				parentArr.splice(Pline.indexOfObj(parentArr, 'name', trackname)+1, 0, odata); //place it after the current option
				self.parseOption(odata, parentArr, optval); //parse & register (optval = initital val. || computed obs.)
			} else if(typeof(optval)=='function'){ //replace plain => computed observable
				self.options[optname] = optval;
			}
		}

		//create (or update) all options found in selection lists
		if(self.selopt){ //run only once
			$.each(self.selopt, function(selection, options){
				$.each(options, function(optname, optval){
					self.log('Adding/updating option '+optname+' = '+optval+' from selection '+selection);
					addOption(optname, optval);
				});
			});
			self.selopt = false;
		}
	
		//register options that merge values from other inputs
		if(self.mergeopt && data.option && self.mergeopt[data.option]){
			var opts = self.mergeopt[data.option]; //list of merged options
			self.log('Merged option '+data.option+' created from '+opts.tnames.join('+'));
			var optlist = self.options[data.option+'_mergelist'] = opts.tnames;
			optlist.valuesep = opts.valuesep;
			//create the target observable (for storing the merged argument value)
			addOption(data.option, ko.computed({
				read: function(){ //merge values from component inputs
					var mergedval = [];
					optlist._timer = new Date().getTime();
					optlist.forEach(function(oname){
						var v = self.options[oname]();
						if(typeof(v)=='number' || (typeof(v)=='string'&&v&&v!=='false'&&v!=='true')) mergedval.push(v); 
					});
					mergedval = mergedval.join(optlist.valuesep);
					self.log('Value of the merged option: '+mergedval, {name: data.option, title: true});
					return mergedval;
				},
				write: function(mergedval){ //split & sync values back to the component inputs
					if(new Date().getTime()-optlist._timer<100) return; //prevent read-write loop
					self.log('Incoming merged value: '+mergedval, {name: data.option, title: true});
					if(typeof(mergedval) != 'string') return;
					var optvals = mergedval.split(optlist.valuesep);
					optlist.forEach( function(oname){
						self.options[oname](optvals[0]);
						if(self.options[oname]()===optvals[0]) optvals.shift(); //value accepted by component
					});
					if(optvals.length) self.log('Failed to sync some values back to the component inputs: '+optvals.join(','), {name: data.option, title: true});
				}
			}));
			
			delete self.mergeopt[data.option];
			if(!Object.keys(self.mergeopt).length) self.mergeopt = false;
		}
		
		var trackvar = self.options[trackname];
		
		if(trackvar.syncopts && !("syncfunc" in trackvar)){ //set up (options=>linked selection option) feedback loop
			trackvar.syncfunc = ko.computed(function(){ //track values of the linked options
				var trackname = data.name;
				var trackvar = self.options[trackname];
				for(var optname in trackvar.syncopts){ //update linked option values
					trackvar.syncopts[optname] = self.options[optname]();
					if(trackvar.syncopts[optname]=='' && self.options[optname].otype=='text' && ("defaultval" in self.options[optname])){
						trackvar.syncopts[optname] = self.options[optname].defaultval; //use default value for empty text inputs
					}
				}
				if(trackvar._locked) return false;
				//self.log('Checking selection list "'+trackname+'" for match to linked options: '+JSON.stringify(trackvar.syncopts));
				var selarr = trackname+"_selection";
				var defaultsel = '';
				var match = false;
				//select an item if it matches its {options:values} set
				$.each(self.options[selarr], function(i, selitem){
					if(!selitem.opt || !Object.keys(selitem.opt).length){
						if("defaultval" in trackvar && trackvar.defaultval==selitem.v) defaultsel = selitem.v;
						return true; //skip non-option selection items
					}
					match = true; //reset flag
					$.each(selitem.opt, function(optname, optval){
						if(!(optname in trackvar.syncopts)){
							self.log('Unexpected linked option "'+optname+'" in the selection', trackname);
							match = false; return false;
						}
						if(trackvar.syncopts[optname] != optval){ match = false; return false; }
					});
					if(match){ //selection item passed the filter
						match = selitem;
						return false;
					}
				});
				trackvar._locked = true; //prevent option=>selection=>option loop
				if(match){ //set the selection to the matching list item
					self.log('Options match a selection item:  '+JSON.stringify(match.opt)+' => '+match.v, trackname);
					if(trackvar.peek() != match.v){ //change selection to match the options
						self.log('Changing selection to '+match.v, trackname);
						trackvar.restoreopt = {};
						trackvar(match.v);
					}
				} else { //option values don't match any of the list items.
					var cursel = self.options[selarr][trackvar.sindex.peek()];
					if(cursel && cursel.opt && Object.keys(cursel.opt).length){
						self.log('No match to linked options: clearing selection.', trackname);
						trackvar.restoreopt = {};
						trackvar(defaultsel);
					} else self.log('No match to linked options: keeping current selection', trackname); //selected item has no linked options
				}
				trackvar._locked = false;
				return true;
			});
		}
			
		//conditionally enable/disable option (reveals/hides input)
		if(data.enable||data.disable){
			trackvar.disabled = ko.pureComputed( function(){
				var trackvar = self.options[data.name];
				var rule = data.enable||data.disable;
				var isdisabled = self.ruleToFunc(rule)();
				if(data.enable) isdisabled = !(isdisabled);
				if(isdisabled){
					if(trackvar.peek()) trackvar.oldval = trackvar.peek();
					var resetval = ("defaultval" in trackvar) && trackvar.otype=='text'? trackvar.defaultval : '';
					self.log('Input disabled: '+(data.enable?'!':'')+rule, {name:data.name, title:true});
					trackvar(resetval); //reset input value when hidden
				} else {
					self.log('Input '+(trackvar.oldval?'re-':'')+'enabled: '+(data.disable?'!':'')+rule, 
						{name: data.name, title: true});
					if(trackvar.oldval) trackvar(trackvar.oldval); //restore previous value when re-enabled
				}
				return isdisabled;
			});
		}
		
			
		//input validation
		var rule = data.required || data.check;
		if(rule && !trackvar.errmsg){
			if(rule === true) rule = data.required = data.type+' input required';
			var reqfunc = function(){};
			if(typeof(rule)=='string'){ //rule = <str> (displayed error message)
				reqfunc = function(){
					var trackvar = self.options[data.name];
					var rule = data.required || data.check;
					var defval = trackvar.otype=='text' && ("defaultval" in trackvar)? trackvar.defaultval : '';
					return trackvar()==='' && defval===''? rule : ''; //no input and no default value
				};
			} else {
				if(typeof(rule) == 'object'){ //rule = {rule<str>: message}
					var reqrule = Object.keys(rule)[0];
					reqfunc = self.ruleToFunc(reqrule, "?'"+rule[reqrule]+"':''");
				} else if (Array.isArray(rule)){ //rule = array of rules
					reqfunc = self.ruleToFunc(rule); 
				}
			}
			trackvar.errmsg = ko.pureComputed(reqfunc);
		}

		//all options added => compute output filename(s)
		if(!self.outFiles._parsed){
			//output filenames from plugin JSON
			if(!Array.isArray(self.outFiles)) self.outFiles = [self.outFiles];
			//outfilenames from options
			if($.isArray(self.outfileopt)) self.outFiles = self.outFiles.concat(self.outfileopt);
			self.outFiles = self.outFiles.filter(function(value){ 
				return value; //remove empty values
			}).map(function(value){  //static => computed filenames
				return ko.pureComputed( self.ruleToFunc(value) );
			});
			if(typeof(self.stdout) !== 'function'){ //compute stdout filename
				self.stdout = ko.pureComputed( self.ruleToFunc(self.stdout) );
			}
			self.outFiles._parsed = true; //run once
			delete self.outfileopt
		}
	},//finishOption
	
	//addPlugin => parse the plugin data: iterate through groups of plugin options
	parseOptions: function(data, parentArr){
		var self = this;
		if(!data && !parentArr) data = self.json;
		if(typeof(data)!='object') return;
		
		['line','group','section'].forEach( function(label){ //labelled options group?
			if(label in data && typeof(data[label]) != 'string'){
				if(Array.isArray(data[label])) data.options = data[label]; //group=>options shortcut
				data[label] = '';
			}
		});
		
		if(Array.isArray(data.options)){ //parse options group		
			for(var i=0, opt=data.options[i]; i<data.options.length; i++, opt=data.options[i]){
				if(typeof(opt)=='object'){
					['prefix','merge'].forEach( function(attr){ //inherited option attributes
						if(attr in data && !(attr in opt)) opt[attr] = data[attr];
					});
				}
				self.parseOptions(opt, data.options);
			}
			
			if(typeof(data.required)=='string'){ //user input required for the options group
				if(!data.name) data.name = '_optgroup'+Object.keys(self).length;
				var reqvar = data.name;
				if(!self.options[reqvar]){
					var optnames = [];
					//list all program option inputs in the group (incl. subgroups)
					var listNames = function(odata){
						for(var i in odata.options){
							var o = odata.options[i];
							if(o.options) listNames(o);
							else if(o.name && o.type && o.type!='hidden') optnames.push(o.name);
						}
					};
					listNames(data);
					//return error message when all of the enabled inputs are empty
					self.options[reqvar] = ko.pureComputed(function(){
						var ovalues = '';
						optnames.forEach( function(name){
							ovalues += self.options[name]()||''; //disabled inputs = '' or placeholder (if text)
						});
						return Pline.submitted()&&!ovalues? data.required : '';
					});
				}
			}
		} else { //parse a single option
			if(!self.ready) self.parseOption(data, parentArr); //first pass
			else self.finishOption(data, parentArr); //second pass
		}
		self.curopt = '';
	},

	// -- Plugin interface builder functions -- //
	//make a HTML input element for a single plugin option
	//Input: parsed option data. Output: datamodel-linked input element(s) (jQuery)
	renderOption: function(data){
		var self = this;
		var pipeline = self.step; //plugin is (2nd or later) step in a pipeline
		var elems = []; //additional html elements
		
		//interface text
		if(typeof(data)=='string'){
			//self.log('Adding text element:'+data);
			return $('<span>'+data+'</span>');
		}
		if(typeof(data)!='object' || !(data.name||data.info)){ self.log('Invalid option data: '+JSON.stringify(data)); return; }
		if(data.info){ //info icon
			//self.log('Adding info icon: '+data.info.substring(0, 10)+'...');
			return '<span class="pl-action pl-icon pl-info" title="'+data.info+'">ⓘ</span>';
		}
		
		//option in datamodel
		var trackname = data.name;
		var trackvar = self.options[trackname];
		var kovar = "$data.options['"+trackname+"']"; //tracker var reference in html
		var otype = trackvar.otype; //input type (text|checkbox|hidden|select)
		if(!otype){ self.log(trackname+": unparsed input type!"); otype = data.type }
		//create the input element
		var el = $('<'+(otype=='select'?'select':'input')+' type="'+otype+'">');
		
		//numerical text input
		if(~["number","float","int"].indexOf(data.type)){
			el.addClass("pl-num");
			if(data.default && !data.width){ //guesstimate suitable input width
				var dval = Array.isArray(data.default)? data.default[data.default.length-1] : data.default;
				dval = dval.toString? dval.toString() : '   ';
				if(dval.length<3) el.addClass("pl-short");
				else if(dval.length>4) el.addClass("pl-long");
			}
		}
		
		//link input to program argument
		if("argname" in data){
			if(!data.option.length) el.attr("trackname", trackname);
			if(!data.proxyInput) el.attr("name", data.argname); //name = "" (positional arg.) | "prefix+argname" (named arg.)
		}
		
		//bind interface input to the tracked option value
		kobind = (otype=="checkbox"?"checked":"value")+":"+kovar+", name:'"+trackname+"'";
		
		//specified input field width
		if(otype=='text' && data.width){
			if(data.width=='auto'){ //auto-grow with input
				kobind = "textInput:"+kovar+", name:'"+trackname+"', style:{width:Math.max("+kovar+"().toString().length*8, 50)+'px'}";
			} else {
				el.css("width", data.width);
			}
		}
		
		//fixed option value (disabled input)
		if(data.fixed) kobind += ", disable:"+self.parseRule(data.fixed);
		
		//set conditional default value (via custom binding)
		if("default" in data){
			kobind += ", default:"+self.parseRule(data.default);
		}
		
		if(data.type == "file"){
			//add text field for a custom filename
			if(pipeline){
				elems.push($('<input type="text" style="width:120px;margin-left:5px" data-bind="visible:$data.options[\''+trackname+'_sel\']()==\'_custom_\', '+
				  'value:'+kovar+'.filename" placeholder="outfile.txt">'));
			}
			
			//argname label
			var namelabel = data.argname? '<span class="pl-namelabel">'+data.argname+'</span>' : '';
					
			//add filedrop area
			var filedrag = $('<div class="pl-filedrag" data-bind="visible:!'+kovar+'.filepath()&&!'+kovar+'.filename(), '+
			'event:{dragover:'+kovar+'.evt.dragover, drop:'+kovar+'.evt.drop}" '+
			'ondragover="this.classList.add(\'pl-dragover\')" ondragleave="this.classList.remove(\'pl-dragover\')" ondrop="this.classList.remove(\'pl-dragover\')" '+
			'title="'+data.desc+'">'+(data.title||'Drop file here')+'</div>');
			if(pipeline) filedrag.css('width','auto');
			
			//add file import button
			var selectbtn = $('<a class="pl-button pl-square pl-small" title="Select a file from your computer" data-bind="click:'+kovar+'.evt.click">Select</a>');
			var fileinput = $('<input type="file" style="display:none" data-bind="event:{change:'+kovar+'.evt.change}">');			
			filedrag.append(selectbtn, fileinput);
			
			//event handlers for filedrag & fileselect
			trackvar.evt = {
				dragover: function(plugin, e){
					e.originalEvent.dataTransfer.dropEffect = 'copy';
					e.stopPropagation();
				},
				drop: function(plugin, e){
					e.stopPropagation();
					trackvar.container(e.originalEvent.dataTransfer.files);
				},
				click: function(plugin, e){ //redirect click: btn=>fileinput
					fileinput.click();
				},
				change: function(plugin, e){ //redirect files: fileinput=>observable
					trackvar.container(this.files);
				}
			};
			
			//display file info & view/remove buttons after dropped file is imported
			var filelist = $('<!-- ko if: '+kovar+'.container&&'+kovar+'.container().length --><div class="pl-file">'+(data.title||'Supplied file')+
			  ':<span class="pl-icon">📎</span><span class="pl-filename" data-bind="text:'+kovar+'.filename"></span></div><!-- /ko -->');
			var filedel = $('<span class="pl-action pl-icon" title="Remove the file" data-bind="click:function(){'+
			  kovar+'.container([])}">ⓧ</span>');
			filelist.append(filedel);
			filedrag.prepend(namelabel);
			var filediv = $('<div class="pl-filediv">').append(filedrag, filelist);
			if(pipeline) filediv.css('display', 'inline-block');
			elems.push(filediv);
		}
				
		//build a selection list of options/values
		if(data.type=="select"){
			//icon for selection item info
			elems.push('<span class="pl-action pl-icon pl-info" data-bind="visible:'+kovar+'.desc, attr:{title:'+kovar+'.desc}">ⓘ</span>');
			//set up disabled/multiselect items
			var disopt ='', multiopt = '', selarr = trackname+"_selection";
			if(trackvar.addrule){ //add binding to selection items (dynamic hiding)
		    disopt = ", optionsAfterRender: "+kovar+".addrule";
			}
			if("multi" in data){ //merge multiple-selection values
				multiopt = ", selectedOptions: "+kovar+".selectedarr";
				el.attr({multiple: true, size: Math.min(5, self.options[selarr].length)}); //change to multiple-selection input
			}
			//link to input element
			kobind += disopt+multiopt+", options:$data.options['"+selarr+"'], optionsValue:'v', optionsText:'t'"+(trackvar.syncopts?', valueAllowUnset:true':'');
		}
		
		//bind input element to the datamodel
		el.attr("data-bind", kobind);
		
		//add a text label next to the input element
		if(otype!="hidden"){
			if(data.css) el.attr("style", data.css); //css string from plugin data
			if(data.argname) el.attr("title", data.argname); //show command-line argument on input hover
			var tspan = data.title? $('<span>'+data.title+'</span>') : ''; //add input label
			if(data.desc){ //show description on mouseover
				var desc = data.argname? 'Option '+data.argname+': '+data.desc : data.desc;
				if(tspan) tspan.addClass("pl-label"); (tspan||el).attr("title", desc);
			}
			if(tspan){ el = otype=='checkbox'? el.add(tspan) : tspan.add(el); }
		}
		
		//hide the input element when disabled
		var kobind_box = data.enable||data.disable? "ifnot:"+kovar+".disabled" : "";
		
		//input validation
		if(data.required || data.check){
			//add error message container
			elems.push('<!-- ko if:'+(data.required?'Pline.submitted()&&':'')+kovar+'.errmsg() --><p class="pl-error" data-bind="text:'+kovar+'.errmsg"></p><!-- /ko -->');
			kobind_box += (kobind_box?", ":"")+"css:{'pl-error':"+(data.required?'Pline.submitted()&&':'')+kovar+".errmsg()}";
		}
		
		//wrap up
		var box = $("<div>");
		box.append(el); //include the input element
		$.each(elems, function(i, elem){ box.append(elem) }); //include additional html
		if(kobind_box) box.attr("data-bind", kobind_box); //bind the wrapper div to datmodel
		if("line" in data) box.addClass("pl-inline"); //place option(s) to a line
		self.curopt = '';
		return box;
	},
	
	//build the input form (with input elements from renderOption)
	//Input: options data. Ouptut: html (jQuery)
	renderOptions: function(data, parentArr){
		var self = this;
		var UI = $('<div>');
		if(Array.isArray(data.options)){ //process options group		
			for(var i=0, opt=data.options[i]; i<data.options.length; i++, opt=data.options[i]){
				UI.append(self.renderOptions(opt, data.options));
			}
			
			//wrap the options to container
			if("group" in data){
				UI.addClass("pl-insidediv pl-numinput");
				var titleattr = {title:data.group||'Options', desc:data.desc||'Click to toggle options', inline:true, keepw:true};
				if(data.collapsed===false) titleattr.open = true;
				else UI.css({"display":"none"});
				UI = $('<div>').append(Pline.makeSection(titleattr), UI);
			}
			else if("section" in data){
				var title = data.desc? ' class="pl-label" title="'+data.desc+'"' : '';
				UI.prepend('<div class="pl-sectiontitle">'+(data.section?'<span'+title+'>'+data.section+'</span>':'')+'</div>');
			}
			else if("line" in data){
				if(data.line){
					var title = data.desc? ' class="pl-label" title="'+data.desc+'"' : '';
					UI.prepend('<span'+title+'>'+data.line+' </span>');
				}
				$(UI).addClass('pl-inlinegroup');
			}
			
			//apply rules
			var kobind = "";
			if(data.enable||data.disable) kobind = "if"+(data.disable?"not":"")+":"+self.parseRule(data.enable||data.disable);
			if(typeof(data.required)=='string'){ //check user input
				UI.append('<!-- ko if:$data[\''+data.name+'\'] --><p class="pl-error" data-bind="text:$data[\''+data.name+'\']"></p><!-- /ko -->');
				kobind += (kobind?", ":"")+"css:{'pl-error':$data[\'"+data.name+"\']}"; //data.name: dynamic error message (ko.computed)
			}
			if(kobind) UI.attr("data-bind", kobind);
			if(data.css) UI.attr("style", data.css);
		} else {
			UI = self.renderOption(data); //parse a single option
		}
		return UI;
	},
	
	//optional header UI builder for custom content
	//input = output = jQuery obj. of the header <div>
	processHeader: function(header){
		return header;
	},
	
	//assemble the plugin interface header (job name input & presets)
	renderHeader: function(){
		var data = this.json;
		//header for the plugin and working directory info
		var desc = '';
		if(data.desc){
			if(/\w$/.test(data.desc)) data.desc += '.';
			desc = (data.url? '<a href="'+data.url+'" title="Open the homepage" target="_blank">'+this.title+'</a>' : this.title) +': '+ data.desc.charAt(0).toLowerCase() + data.desc.slice(1);
		}
		if(data.info) desc += ' <span class="pl-action pl-icon pl-info" title="'+data.info+'">ⓘ</span>';
		
		var nameinput = $('<input type="text" class="pl-faded" data-bind="value:jobName" title="Click to edit">');
		var namediv = $('<div class="pl-jobname">'+(desc?'<hr>':'')+'<span class="pl-note">Task name: </span></div>').append(nameinput);
		var content = this.processHeader($('<div class="pl-header">').append(desc, namediv));
		
		//header for stored parameter configurations
		var conf = '';
		if(Pline.settings.presets && !this.step){
			conf = '<hr><span class="pl-label" title="Restore input values from a stored preset or save a new one.">Restore inputs:</span>'+
			' <select style="width:140px" data-bind="visible:!preset.edit(), value:preset, options:presets, optionsText:\'name\', optionsCaption:\'Choose a preset:\'"></select>'+
			' <input style="width:140px;margin-left:5px" data-bind="visible:preset.edit, value:preset.newname" placeholder="New preset name"></input>'+
			'<a class="pl-button pl-small pl-square" data-bind="click:addPreset,text:preset.edit()?\'Save\':\'Add\', attr:{title:preset.edit()?\'Save the new preset\':\'Save current option values to a new preset\'}"></a>'+
			'<a class="pl-button pl-small pl-round pl-red" style="padding:0 6px 2px 7px" title="Cancel adding the preset" data-bind="visible:preset.edit,click:preset.edit.bind(this,false)">x</a>'+
			'<a class="pl-button pl-small pl-square pl-red" data-bind="visible:preset()&&!preset.edit(), click:removePreset" title="Remove the selected preset">Del</a>'+
			'<div style="color:#666;height:20px;" data-bind="text:preset.status, fadevisible:preset.status"></div>';
		}
		
		var header = content||conf? $('<div class="pl-insidediv">').append(content, conf) : '';
		return header;
	},
	
	//assemble the plugin interface (header + input form)
	renderUI: function(){
		var header = this.renderHeader();
		var self = this;
		
		//build HTML interface
		var data = self.json;
		var optformUI = self.renderOptions(data);
		var optform = $('<form class="pl-form" id="'+self.id+'_form" onsubmit="return false"></form>').append(optformUI);
		if(self.errors.length) self.showError('Plugin interface building failed for '+self.title);
		var content = $('<div id="'+self.id+'" class="pl-plugin" data-bind="css:{\'pl-pipe\':pipe().length}">').append(header, optform);

		if(self.step){ //pipeline step: add wrapper
			content.addClass('pl-pluginstep').wrapInner('<div class="pl-insidediv"></div>').prepend('<span class="pl-nr">'+
			(self.step+1)+'</span>', Pline.makeSection({title:self.title, desc:'Click to toggle plugin options', open:true, inline:true, keepw:true}), 
			'<a data-bind="visible:step==Pline.pipeline().length-1,click:removePluginStep" class="pl-button pl-square pl-small" '+
			'style="float:right" title="Remove this analysis step from the pipeline">Remove</a>');
		}
		
		self.log('Plugin interface rendered', {title: true});
		return content;
	},
	
	//validate & parse plugin JSON
	initPlugin: function(){
		var self = this;
		data = self.json;
		if(!data) return self.error('input JSON missing');
		if(typeof(data) == 'string'){ //parse JSON or object string
			try {
				data = Function('return ('+ data +')')();
			} catch(e) {
				e += ' @ line '+e.lineNumber+', column '+e.columnNumber;
				return self.error('Failed to parse plugin file: '+e, 'show');
			}
		} else if(typeof(data) != 'object') {
			return self.error('plugin file in wrong format: '+typeof(data)+' (JSON or Object expected)', 'show');
		}
		
		self.json = data; //parsed JSON
		if(!data.options) return self.error('Options list missing from the JSON');
		if(!data.program) return self.error('Program name missing from the JSON');
		//register plugin attributes
		if(data.configFile) self.prefix = '';
		Object.keys(data).forEach( function(attr){
			if(attr == 'options') return;
			//read plugin attributes
			if(attr=='enable' || attr=='disable'){ //rescope
				data['p'+attr] = data[attr];
				delete data[attr];
			} else if(attr=='jobName' && data.jobName){
				self.jobName(data.jobName); //observable
			} else { //copy
				self[attr] = data[attr];
			}
		});
		self.title = data.name || data.program;
		if(Pline.plugins[self.title] && !self.step){
			self.error('Plugin '+self.title+' already imported', 'warning');
			return Pline.plugins[self.title];
		}
		if(!self.id) self.id = self.title.replace(/\W/g,'_');
		if(!self.path) self.path = self.program;
		
		//optional plugin data parsing
		if(typeof(self.processPlugin)=='function') self.processPlugin(data);
		
		//load stored presets
		self.presets(self.editStorage(self.title+'_presets')||[]);
		
		self.log('= New plugin =', {title:true});
		//plugin data OK
		return true;
	},
	
	//hook: addPlugin() follow-up
	registerPlugin: function(){
		//optional actions for plugin registration (this = plugin instance)
		//example: add button for launching the registered plugins:
		//$('<a class="pl-button pl-square" onclick="Pline.makeMenu(this)">Plugins</a>').appendTo('body');
	},
	
	// -- Functions for submitting the plugin/pipeline jobs -- //
	//send the job to server
	submitJob: function(){
		var self = this;
		Pline.submitted(true);
		setTimeout(function(){ //wait for error messages
			var errors = $("p.pl-error", self.UIcontainer);
			if(errors.length){ //show input errors
				self.btnText("Check the errors!");
				setTimeout(function(){ errors.filter(':hidden').parents('.pl-insidediv').slideDown(); }, 1000);
			} else{
				self.sendJob();
			}
		}, 100);
	},
	
	//optional pre-flight check. Return an error message to cancel sendJob()
	checkJob: function(){
		return false;
	},
	
	//process user input & files
	prepareJob: function(){
		var self = this;
		//senddata: {name:'pluginName', [email:'@addr'], input_filename1:'filedata1', ..., pipeline:[ {plugin1}, {plugin2} ]}
		//plugins: {name:'jobName', program:'cmd', parameters:'param1 param2', 
		//           infiles:'file1,file2', outfiles:'file1,file2', stdout:'filename', plugin:'path/plugin.json'}
	
		var senddata = {name: self.jobName(), pipeline: []};
		
		//process plugin interface input form
		Pline.pipeline().forEach( function(plugin_id){
			var plugin = Pline.plugins[plugin_id];
			var payload = {
				name: plugin.jobName(), program: plugin.program, parameters: [], infiles: [], 
				outfiles: '', stdout: plugin.stdout(), plugin: plugin.path
			};
			
			//add computed output filenames
			var ofiles = []
			plugin.outFiles.forEach( function(obs){
				ofiles.push(obs());
			});
			ofiles.push(plugin.stdout());
			//remove empty and duplicate filenames
			ofiles = ofiles.filter(function(filename, i){
				if(typeof(filename) != 'string' || !filename.length) return false;
				return ofiles.indexOf(filename) == i;
			}).map(function(filename){
				if(filename.charAt(0) == '.') return 'output'+filename;
				return filename;
			});
			payload.outfiles = ofiles.join(',');
			
			var form = $('#'+plugin.id+'_form');
			var filenames = {};
			var head = [], tail = [];
			
			//parse applicable option inputs
			form.find('input[name], select[name]') //option inputs
			.not('[type=file], [type=checkbox]:not(:checked)') //skip empy/unused inputs
			.each(function(){
				this.value = this.value.trim()
				if(!this.value.length || this.value == 'false' || this.value == '_pipe_'){
					return true; //skip empty inputs
				} else if (this.type=='checkbox'){
					this.value = 'true'; //normalize enabled checkbox values
				}
				var optname = this.name.replace(/^\W+/, ''); //option name
				var tname = this.getAttribute('trackname'); //trackname (only for empty option names)
				var opt = plugin.options[tname||optname]; //option value accessor in the datamodel
				if(!opt){
					plugin.log('prepareJob: Option missing from the datamodel:', {name:tname, obj:plugin});
					return true;
				} else if (opt.defaultval && this.value == opt.defaultval){
					return true; //skip params with its default values
				}
				
				plugin.processInput(this, opt, payload); //optional parser
				
				if(opt.container){ //input file
					var filename = opt.filename();
					var filepath = opt.filepath();
					if(opt.container().length && !filepath){ //user-supplied file
						var file = opt.container()[0]; //filecontent
						if(!file){ //skip empty files
							plugin.log('Empty file!', {title:true, name:optname});
							return true;
						}
						//check for duplicate filenames
						if(!filenames[filename]) filenames[filename] = 1;
						else filename += ++filenames[filename];
						senddata[filename] = file; //File object
					}
					payload.infiles.push(filepath+filename); //register input file
				}
				//add parameter to the list
				var valuesep = optname.length? plugin.valueSep:'';
				if(/[\\`*@$ ]/.test(this.value)){
					this.value = "'"+this.value.replace(/["']/g,'')+"'"; //quote input value
				}
				if(this.value.length){
					//param = paramname (flag) | paramvalue (positional) | paramname=paramvalue
					var param = (optname.length? this.name : '') + (this.value == 'true'? '' : valuesep+this.value);
					if(opt.argpos == 'start') head.push(param); //rearrange parameter position
					else if(opt.argpos == 'end') tail.push(param);
					else payload.parameters.push(param); //original order
				}
			}); //foreach input
			
			//add rearranged parameters
			if(head.length) payload.parameters = head.concat(payload.parameters);
			if(tail.length) payload.parameters = payload.parameters.concat(tail);

			if(plugin.configFile){ //move parameters to config file
				if(!filenames[plugin.configFile]) filenames[plugin.configFile] = 1;
				else plugin.configFile += ++filenames[plugin.configFile];
				payload.infiles.push(plugin.configFile); 
				senddata[plugin.configFile] = payload.parameters.join("\n");
				plugin.log('Parameters to configfile: '+payload.parameters.join(' '), {title:true});
				var valuesep = /\w$/.test(plugin.configParam)? ' ' : ''; //add space if needed
				var prefix = /^\w/.test(plugin.configParam)? '-' : ''; //add prefix if needed
				payload.parameters = [prefix + plugin.configParam + valuesep + plugin.configFile]; //add the configfile param
			}
			
			//add plugin data to server payload
			payload.infiles = payload.infiles.join(',');
			payload.parameters = payload.parameters.join(' ');
			//postprocess server-bound payload for each plugin
			payload = plugin.processPayload(payload);
			//merge to the previous step as a piped command
			if(plugin.pipe().length && senddata.pipeline.length){
				var prevstep = senddata.pipeline.pop();
				['plugin','program','parameters'].forEach( function(p){
					prevstep[p] +=  '|'+payload[p];
				});
				prevstep.infiles = [prevstep.infiles, payload.infiles].join(',');
				//check for duplicate outfiles across the pipeline
				ofiles = prevstep.outfiles.split(',').concat(ofiles);
				ofiles = ofiles.filter(function(filename, i){
					if(ofiles.indexOf(filename) !== i){
						plugin.error('Pipeline program '+payload.program+' will overwrite output file '+filename+' from the previous step', 'warning');
						return false;
					}
					return true;
				});
				prevstep.outfiles = ofiles.join(',');
				prevstep.stdout = payload.stdout;
				payload = prevstep;
			}
			senddata.pipeline.push(payload);
			plugin.log('Terminal command: '+payload.program+' '+payload.parameters, {title:true});
		});
		if(Pline.settings.email.includes('@')) senddata.email = Pline.settings.email;
		self.processJob(senddata); //postprocess assembled payload to the server
		return senddata;
	},
	
	//optional parser for each plugin form input
	//(input: form input element, opt: linked trackvar, payload: submitted plugin data)
	processInput: function(input, opt, payload){
		return payload;
	},
	
	//optional parser for the submitted plugin data
	//(payload: plugin-specific dataset to be sent to the server)
	processPayload: function(payload){
		return payload;
	},
	
	//optional parser for the submitted total data
	//(payload: assembled total dataset to be sent to the server)
	processJob: function(payload){
		return payload;
	},

	//submit a background job to the server (plugin/plugin pipeline)
	sendJob: function(){
		if(Pline.sending()) return;
		var self = this;
		
		var payload = self.prepareJob();
		var msg = self.checkJob(); //preflight check
		if(msg){
			self.showError('Job submission failed', msg);
			return false;
		}
		
		Pline.sending(true);
		var formdata = new FormData();
		if(typeof(Pline.settings.sendData)=='object') Object.assign(payload, Pline.settings.sendData);
		payload.action = 'run';
		$.each(payload, function(key, val){ //convert payload Obj to formData
			if(typeof(val)=='object' && !(val instanceof Blob)) val = JSON.stringify(val);
			if(val) formdata.append(key, val);
		});
		
		return $.ajax({
			method: "POST",
			url: Pline.sendAddress,
			data: formdata, //send as formData
			success: function(resp){
				self.btnText('Job sent!');
				self.jobSent(resp);
			},
			error: function(xhr, status, msg){
				self.btnText('Sending failed!');
				self.showError('Job sending failed', msg);
				self.jobFailed(msg);
			},
			complete: function(xhr, status){
				self.resetPlugins();
				self.afterSubmit(status);
			},
			xhr: function(){
				var xhr = $.ajaxSettings.xhr();
				xhr.upload.onprogress = function(evt){
					self.btnText('Sending: '+parseInt(evt.loaded/evt.total*100)+'%');
				};
				return xhr;
			},
		  contentType: false, //no content-type header
		  processData: false //no processing on formdata
		});
	},
	
	//hook: job sent
	jobSent: function(response){
		//optional actions after job has been sent
		//response = server confirmation: {id: newJobID}
	},

	//hook: job sending failed
	jobFailed: function(msg){
		//optional actions after job sending failed
		//msg = error message from the server
	},
	
	//hook: sendJob() follow-up
	afterSubmit: function(status){
		//optional actions after job has been submitted
		//status = request status ('success'|'error'|'timeout'|...)
	},

	//sendJob() follow-up
	resetPlugins: function(){
		var self = this;
		Pline.submitted(false);
		Pline.sending(false);
		if(Pline.settings.cleanup){ //remove interface
			Pline.clearPipeline('remove');
		}
	}
};//Pline.plugin.prototype

//custom extensions for the Knockout library:
//format observable value in-place
ko.extenders.format = function(obsitem, format){
		var formatted = ko.pureComputed({
				read: obsitem,
				write: function(input){
			var newval = input;
			if(format=='trim' && typeof(input)=='string') newval = input.trim();
			else if(format=='nospace') newval = input.replace(/\s/g,'_');
			else if(format=='alphanum') newval = input.replace(/\s/g,'_').replace(/[^\w\.]/g,'');
			else if(~['number', 'float', 'int', 'posit'].indexOf(format)){
						if(input!=""){
							if(isNaN(input)) newval = 0;
					newval = format=='int'? parseInt(newval) : parseFloat(newval);
					if(isNaN(newval)||(format=='posit' && newval<0)) newval = 0;
					if(typeof(input)=='string') newval = newval.toString(); //from input element
				}
			}
			if(obsitem()!==newval) obsitem(newval);
			else if(input!==newval) obsitem.notifySubscribers(newval);
				}
		}).extend({notify: 'always'});;
	formatted(obsitem()); //format initial value
	return formatted;
};

//set a default value for plugin input element
ko.bindingHandlers.default = {
	update: function(element, accessor, allBindings, viewModel, bindingContext){
		var defaultval = ko.unwrap(accessor());
		var trackname = ko.unwrap(allBindings.get('name')); //data-bind:"name"
		if(!trackname || typeof(defaultval)=='undefined') return;
		bindingContext.$data.options[trackname].defaultval = defaultval;
		if(element.type=='text'){ //text inputs
			var inputval = ko.unwrap(allBindings.get('value'));
			var required = ko.unwrap(allBindings.get('required'));
			element.setAttribute('placeholder', defaultval);
			if(required && !inputval.length) element.value = defaultval;
			else if(!required && inputval==defaultval) element.value = '';
		} else { bindingContext.$data.options[trackname](defaultval); }
	}
};

//hide/reveal interface element
ko.bindingHandlers.fadevisible = {
	init: function(element){
		$(element).css('display','none') },
    update: function(element, accessor){
			var value = ko.unwrap(accessor());
      if(value) $(element).fadeIn(); else $(element).hide();
    }
};

//reduce observable value refreshrate
ko.options.deferUpdates = true;
