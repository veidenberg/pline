<p align="center">
  <img width="570" alt="Pline header" src="https://user-images.githubusercontent.com/1215700/74085678-457a4180-4a84-11ea-84ac-be8dd2150465.png">
</p>

# Pline

[Documentation ⇢](http://wasabiapp.org/pline)  
[Demo site ⇢](http://wasabiapp.org/pline-demo)  
[Preprint article ⇢](https://doi.org/10.22541/au.159863310.09115756)

**JSON-based web interfaces for command-line programs**

Pline is a specification for describing command-line programs and their interfaces, and its implementation as a lightweight web app. Pline renders web interfaces from JSON-formatted interface descriptions in `plugin.json` files. Custom interfaces can be written using the [plugin API](http://wasabiapp.org/pline/guide/api.html) and distributed by e.g. publishing the JSON files to the [plugins repository](https://github.com/veidenberg/pline-plugins). Pline was designed with the bioinformatics community in mind, but the domain-agnostic API makes it easy to craft graphical interfaces for any command-line executable.
Documentation, downloads and example interfaces are available on the [Pline website](http://wasabiapp.org/pline).

## Installation

Download and unzip Pline+plugin bundles from the [Pline website](http://wasabiapp.org/pline/downloads), or:
1) Clone/download this repository
2) Add interfaces from the [plugins repository](https://github.com/veidenberg/pline-plugins)

## Usage

1) Go to the Pline directory and launch the server: `python pline_server.py` (or just `./pline`)
2) Point a web browser to http://localhost:8000
3) Select an interface from the **Tools** menu
4) Fill the inputs and click **RUN** to launch the tool
5) The input/output/log files are accessible in the analyses folder (by default `Pline/analyses/`)

## Configuration

Pline can be run as a desktop web app or as a shared/public web service. 
The server configuration can be changed in `server_settings.cfg` or set with launch parameters (see `./pline --help`).
