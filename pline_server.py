#!/usr/bin/env python
#coding: utf-8

# === Back-end server for Pline web application ===
# http://plineapp.org/pline
# Compatible with Python 2.7+ and Python 3+
# Andres Veidenberg (andres.veidenberg[at]helsinki.fi), University of Helsinki, 2019
# Distributed under the MIT license [https://opensource.org/licenses/MIT]

#import some standard libraries
import argparse
import cgi
try: #if python 3
    import configparser
except ImportError: #rename for python 2
    import ConfigParser as configparser 
from glob import glob
import json
import logging
import logging.handlers
import multiprocessing
import os
try: #python 3
    import queue
except ImportError: #python 2
    import Queue as queue
import re
import resource
import shlex
import shutil
import smtplib
import socket
from subprocess import Popen, PIPE
import sys
import tempfile
import threading
import time
try:  #python 3
    from urllib.request import urlopen
    from urllib.parse import unquote
    from urllib.error import URLError
except ImportError:  #python 2
    from urllib import unquote, urlopen
    from urllib2 import URLError
import webbrowser
try:  #python 3
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
except ImportError:  #python 2
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer
    from SocketServer import ThreadingMixIn

#Define globals
version = 200128
serverpath = os.path.realpath(__file__)
plinedir = os.path.dirname(serverpath)
os.chdir(plinedir)
#Pline OSX bundle
osxbundle = False
if(os.path.isfile('AppSettings.plist')):
    osxbundle = True
    plinedir = os.path.dirname(plinedir)

#configuration file parser
def getconf(opt='', vtype=''):
    section = 'server_settings'
    try:
        if(vtype == 'int'): return config.getint(section, opt)
        elif(vtype == 'bool'): return config.getboolean(section, opt)
        else:
            val = config.get(section, opt)
            return '' if(vtype == 'file' and '.' not in val) else val
    except configparser.Error:
        return 0 if(vtype == 'int') else ''

#Set globals from config file
config = configparser.ConfigParser()
config.read('server_settings.cfg')
datadir = os.path.join(plinedir, (getconf('datadir') or 'analyses'))
if not os.path.exists(datadir): os.makedirs(datadir, 0o775)
tempdir = os.path.join(plinedir, 'downloads') #dir for temporary zip files
if not os.path.exists(tempdir): os.makedirs(tempdir, 0o775)
plugindir = os.path.join(plinedir, (getconf('plugindir') or 'plugins'))
if not os.path.exists(plugindir): os.makedirs(plugindir, 0o775)
serverport = getconf('serverport', 'int') or 8000
num_workers = getconf('workerthreads', 'int') or multiprocessing.cpu_count()
cpulimit = getconf('cpulimit', 'int')
datalimit = getconf('datalimit', 'int')
filelimit = getconf('filelimit', 'int')
logtofile = getconf('logfile','bool')
debug = getconf('debug','bool')
local = getconf('local','bool')
gmail = getconf('gmail')
openbrowser = getconf('openbrowser', 'bool')
linuxdesktop = getconf('linuxdesktop', 'bool')
hostname = getconf('hostname') or ''
dataids = getconf('dataids', 'bool')
dataexpire = getconf('dataexpire', 'int')
expiremsg = getconf('expiremsg', 'bool')

datestamp = '' #last data cleanup date
job_queue = None #queue of running programs

sys.stdout.flush() #print to console before logging

#set up logging
class TimedFileHandler(logging.handlers.TimedRotatingFileHandler):
    def _open(self):
        oldmask = os.umask(0o002) #make the logfile group-writable
        fstream = logging.handlers.TimedRotatingFileHandler._open(self)
        os.umask(oldmask) #restore default mask
        return fstream

def start_logging():
    if logtofile:
        loghandler = TimedFileHandler('server.log', when='d', interval=1, backupCount=1)
    else:
        loghandler = logging.StreamHandler()
    loglevel = logging.DEBUG if(debug) else logging.INFO
    loghandler.setLevel(loglevel)
    loghandler.setFormatter(logging.Formatter('%(asctime)s - %(message)s', '%d.%m.%y %H:%M:%S'))
    logging.getLogger().setLevel(loglevel)
    logging.getLogger().addHandler(loghandler)

def info(msg):
    logging.info(msg)

#create linux desktop shortcut
if(sys.platform.startswith('linux') and linuxdesktop):
    try:
        shortcut = os.path.join(plinedir, 'pline.desktop')
        conf = configparser.ConfigParser()
        conf.optionxform = str
        conf.read(shortcut)
        if(conf.get('Desktop Entry', 'Exec') is not serverpath):
            conf.set('Desktop Entry', 'Exec', serverpath)
            conf.set('Desktop Entry', 'Icon', os.path.join(plinedir,'pline_logo.png'))
            with open(shortcut,'wb') as fhandle: conf.write(fhandle)
            shutil.copy(shortcut, os.path.expanduser('~/Desktop'))
    except (configparser.Error, shutil.Error, OSError, IOError) as why:
        print('Setup error: Could not create Linux desktop shortcut: '+str(why))

### Utility functions ###
#check if a filepath is confied to the served directory
def apath(path, d=datadir):
    path = os.path.realpath(path)
    testdir = os.path.realpath(d)
    if(d is 'skip' or path.startswith(testdir)): return path
    else: raise IOError('Restricted path: '+path)

#join paths with confinment check
def joinp(*args, **kwargs):
    confinedir = kwargs.pop('d', datadir)
    return apath(os.path.join(*args), d=confinedir)

#write data to file
def write_file(filepath, filedata='', checkdata=False):
    if(checkdata and not filedata):
        return False
    else:
        f = open(filepath, 'wb')
        f.write(filedata)
        f.close()
        return os.path.basename(f.name)

#send a notification email
def sendmail(subj='Email from Pline', msg='', to=''):
    if not gmail: return 'Failed: sendmail(): no gmail user'
    if not msg or not to: return 'Failed: sendmail(): message or address missing'
    global hostname
    #add footer to the message
    msg += '\r\n\r\n-------------------------------------------------\r\n'
    msg += 'Message sent by Pline (http://wasabiapp.org/pline) from '+hostname+'\r\n\r\n'
    #send the message
    guser, gpass = gmail.split(':')
    if '@' not in guser: guser += '@gmail.com'
    if guser and gpass and '@' in to:
        try:
            gserver = smtplib.SMTP('smtp.gmail.com:587')
            gserver.ehlo()
            gserver.starttls()
            gserver.login(guser,gpass)
            mailstr = '\r\n'.join(['From: '+guser, 'To: '+to, 'Subject: '+subj, '', msg])
            gserver.sendmail(guser, [to], mailstr)
            gserver.quit()
            return 'Sent'
        except:
            return 'Failed: sendmail()'
    else: return 'Failed: sendmail(): faulty user or address'

#send email with job data download link
def send_job_done(jobid):
    if not jobid: return
    md = Metadata(jobid).metadata
    if 'email' not in md: return
    msg = '''This is just a notification that your pipeline ({name}) has finished.
    You can download the results from http://{host}?data={jobid}
    '''.format(name=md.name, host=hostname, jobid=jobid)
    sendmail('Pline pipeline finished', msg, md.email)

#remove obsolete data files
def cleanup():
    global datestamp #last cleanup date

    if not dataexpire: return
    today = time.strftime("%d%m%y")
    if datestamp is not today: #max. 1 cleanup/day
        try:
            for filename in os.listdir(tempdir): #remove temporary downloads
                filepath = os.path.join(tempdir, filename)
                if os.isfile(filename): os.remove(filename)
            if dataexpire: #remove expired datadirs
                for dirname in os.listdir(datadir):
                    dirpath = os.path.join(datadir, dirname)
                    metafile = os.path.join(dirpath, Metadata.FILE)
                    if(not os.path.isdir(dirpath) or not os.path.isfile(metafile)): continue
                    md = Metadata(metafile)
                    if(md['keepData']): continue #keep flagged data dirs (override dataexpire)
                    edittime = os.path.getmtime(metafile)
                    dirage = (time.time()-edittime)//86400 #file age in days
                    if(dirage > dataexpire): #remove expired data dir
                        dircount = len(sum([trio[1] for trio in os.walk(dirpath)],[])) #nr of subdirs
                        shutil.rmtree(apath(dirpath, datadir))
                        info('Cleanup: removed data dir %s (%s analyses from %s days ago)' % (dirname, dircount, int(dirage)))
                    elif(dirage == dataexpire-1 and expiremsg and gmail and  md['email']): #send a reminder email
                        msg = 'The result files from your program run is about to exire in 24h.\r\n'
                        msg += 'You can download the files before the expiry date from: %s/%s' % (hostname, dirname)
                        sendmail('Data expiry reminder', msg, md['email'])
            datestamp = today
        except (OSError, IOError) as why:
            logging.error('Data cleanup failed: '+str(why))

#init dir for new program run
def create_job_dir(name='analysis', d=datadir, metadata={}):
    dirpath = os.path.join(d, name)
    if(d == datadir and dataids): #use randomized root dirname
            dirpath = tempfile.mkdtemp(prefix='', dir=d)
    else:
        i = 2
        inputpath = dirpath
        while(os.path.isdir(dirpath)): #unique dirname check
            dirpath = inputpath + str(i)
            i += 1
        os.mkdir(dirpath)
    os.chmod(dirpath, 0o775)
    
    md = Metadata.create(dirpath)
    if(metadata): md.update(metadata)
    return dirpath

#get total filesize of a dirpath
def getsize(start_path = datadir): 
    total_size = 0
    for dirpath, dirnames, filenames in os.walk(start_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try: total_size += os.path.getsize(fp)
            except OSError: pass
    return total_size

#handle client browser => Pline server requests
class plineServer(BaseHTTPRequestHandler):
    #disable console printout of server events
    def log_message(self, format, *args):
        return

    #send error response (and log error details)
    def sendError(self, errno=404, msg='', action='', skiplog=False):
        if(not skiplog):
            logging.error('Error: request "'+action+'" => '+str(errno)+': '+msg)
            if(debug and action!='GET'): logging.exception('Error details: ')
        if(msg[0]!='{'): msg = '{"error":"'+msg+'"}' #add json padding
        if hasattr(self, 'callback'): #send as jsonp
            msg = self.callback+'('+msg+')'
            self.command = 'HEAD'
            self.send_error(errno)
            self.wfile.write(msg)
        else:
            self.send_error(errno, msg)

    #send OK response (status 200)
    def sendOK(self, msg='', size=0):
        self.send_response(200)
        if size:
            self.send_header("Content-Type", "text/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
        else: self.send_header("Content-Type", "text/plain")
        self.end_headers()
        if msg:
            if hasattr(self, 'callback'): #add jsonp padding
                if(msg[0]!='{' and msg[0]!='['): msg = '{"data":"'+msg+'"}'
                msg = self.callback+'('+msg+')'
            self.wfile.write(msg)

    #HEAD requests
    def do_HEAD(self):
        try:
            self.send_response(200)
            self.end_headers()
            self.wfile.write('URL exists')
            return  
        except IOError:
            self.sendError(404,'File Not Found: %s' % self.path,'HEAD')

    #serve files (GET requests)
    def do_GET(self):
        path = unquote(self.path)
        params = {}
        filename = ''
        filecontent = ''
        rootdir = plinedir
        logfile = False
        
        if path.startswith('/'): path = path[1:]
        path = path.replace('../','')
        
        #parse GET params
        if('?' in path):
            url = path.split('?')
            path = url[0]
            try:
                params = dict([
                    (x.split('=') if '=' in x else (x,'')) for x in url[1].split('&')
                ])
            except ValueError: #faulty params format
                pass
            logging.debug("GET: %s" % (str(params)))

        #POST request mirrors
        postreq = ['checkserver', 'status', 'plugins', 'terminate', 'restart']
        for req in postreq:
            if req in params:
                getattr(self, "post_"+req)(params[req])
                return
        
        #split path to dirpath and filename
        def splitpath(p=path):
            fname = ''
            if('/' in p):
                parr = p.split('/')
                fname = parr.pop()
                if('.' not in fname):
                    parr.append(fname)
                    fname = ''
                p = '/'.join(parr)
            elif('.' in p):
                fname = p
                p = ''
            return (p, fname)
        
        try: #send a file
            if 'data' in params and params['data']: #from the data dir
                rootdir = datadir
                (path, filename) = splitpath(params['data'])
                if not filename: #(job files) direcotry requested: send as a zip archive
                    jobdir = os.path.join(rootdir, path)
                    basedir = path.split('/')[0]
                    if os.path.isdir(jobdir):
                        filename = os.path.basename( shutil.make_archive( os.path.join(tempdir, basedir), 'zip', rootdir, basedir ))
                        rootdir = tempdir
                        path = ''
                    else:
                        raise IOError('Datadir not found: '+basedir)
            elif 'plugin' in params and params['plugin']: #from the plugins dir
                rootdir = plugindir
                (path, filename) = splitpath(params['plugin'])
                if(not filename): filename = 'plugin.json'
            else: #from the server dir
                (path, filename) = splitpath()
                if(not filename): filename = 'index.html'
            
            #set file content-type
            ctype = 'application/octet-stream'
            def ftype(f=filename):
                ctypes = {
                    'text/css': ['css'],
                    'text/javascript': ['js'],
                    'text/html': ['htm', 'html'],
                    'application/json': ['json'],
                    'image/jpg': ['jpg', 'jpeg'],
                    'image/gif': ['gif'],
                    'image/png': ['png']
                }
                for t in ctypes:
                    for ext in ctypes[t]:
                        if filename.endswith('.'+ext): return t
                return 'application/octet-stream'
    
            if 'type' in params and params['type']:
                ctype = params['type']
            elif 'callback' in params and params['callback']: #jsonp requested
                ctype = 'application/json'
                self.callback = params['callback']
            elif(filename): #use file extension
                ctype = ftype(filename)

            #read the requested file (with confinment check)
            rmode = 'r' if 'text' in ctype else 'rb'
            with open(joinp(rootdir, path, filename, d=rootdir), rmode) as f:
                filecontent = f.read()
            if 'callback' in params: #add jsonp padding
                filecontent = filecontent.replace('\n','').replace('\r','').replace('\t','')
                if(filecontent[0]!='{' and filecontent[0]!='['): filecontent = '{"filedata":"'+filecontent.replace('"','\'')+'"}' #textfile
                filecontent = params['callback']+"("+filecontent+")"
            #send data
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", len(filecontent))
            if('image' in ctype): self.send_header("Cache-Control", "max-age=300000")
            if(rootdir is not plinedir): #file download
                self.send_header("Content-Disposition", "attachment; filename="+filename)
            self.end_headers()
            self.wfile.write(filecontent)
        except IOError as e:
            errmsg = 'File Not Found: %s (%s)' % (filename, e.strerror)
            self.sendError(404, errmsg, 'GET')

#======POST request functions========

    #send server status
    def post_checkserver(self, *a):
        global hostname
        hostname = self.headers.get('Host') #update

        status = { "status": "OK" }
        confs = ["version", "local", "dataexpire", "cpulimit", "datalimit", "filelimit"]
        for conf in confs:
            status[conf] = globals()[conf]
        status["datasize"] = getsize(datadir)
        if(gmail): status["email"] = True
        if(local): 
            status["datadir"] = datadir
            if job_queue.jobs: #list of running jobs
                status["jobs"] = job_queue.jobs.keys()

        self.sendOK(json.dumps(status))

    #send plugins list
    def post_plugins(self, *a):
        os.chdir(plugindir)
        pathlist1 = glob(os.path.join('*', 'plugin.json'))
        pathlist2 = glob(os.path.join('pipelines', '*.json'))
        os.chdir(plinedir)
        self.sendOK( json.dumps({ "plugins": pathlist1, "pipelines": pathlist2 }) )
    
    #send status of a program (datadir metadata)
    def post_status(self, jobid):
        if(not jobid):
            raise AttributeError('JobID missing')
        jobs = jobid.split(',')
        status = {}
        for id in jobs: #read metadata
            md = Metadata(joinp(datadir, id))
            md.update_log() #attach log output
            status[id] = json.loads(str(md)) #md => plain obj
        self.sendOK( json.dumps(status) )
    
    #start a new job
    def post_run(self, form):

        #input form => name:'jobName', [email:'@addr'], fname1.txt:'filedata1', pipeline:[{plugin1}, ...]
		#plugin => { name:'stepName', program:'cmd', parameters:'param1=v1 param2', 
        #          infiles:'fname1.txt,...', outfiles:'ofile.txt,...', stdout:'output.log', plugin:'dir/path/pluginname'}

        jobname = form.getvalue('name','untitled')
        response = {}
        jobdir = datadir
        firstid = ''
        notify = False

        #start new background job/pipeline
        pipeline = json.loads(form.getvalue('pipeline','[]'))
        laststep = len(pipeline)
        logging.debug("Submitting job '%s' with %i step(s)" % (jobname, laststep))
        for i, data in enumerate(pipeline): #prepare pipeline files (i=1...len)
            if('name' not in data or 'program' not in data):
                raise AttributeError("'name' or 'progam' missing from the submitted job data!")
            jobname = data['name'].replace(' ', '_')
            jobdir = create_job_dir(jobname, d=jobdir) #init new datadir
            jobid = os.path.relpath(jobdir, datadir)
            md = Metadata(jobdir)
            md['id'] = jobid
            if i == 0:
                firstid = jobid
                if 'email' in data:
                    md['email'] = data['email']
                    notify = True #notification email requested
            for attr in ['name', 'plugin', 'program', 'parameters', 'infiles', 'outfiles', 'stdout']:
                md[attr] = data[attr] if attr in data else '' #store metadata
            step = i+1
            if(laststep > 1):
                md['step'] = "%d/%d" % (step, laststep)
                data['_jobdir'] = jobdir
            if step > 1: #add link to previous step
                Metadata(pipeline[i-1]['_jobdir']).update('nextstep', jobid)
            if i == laststep and notify:
                md['notify'] = firstid
            md.flush()
            #store input files
            for filename in data['infiles'].split(','):
                if(not filename.startswith('../')):
                    write_file(joinp(jobdir, filename, d=jobdir), form.getvalue(filename, ''), True)
    
        if firstid:
            Job(firstid) #start the pipeline
            response["id"] = firstid

        self.sendOK(json.dumps(response))
    
    #check for valid jobdir path
    def check_id(self, form):
        jobid = form.getvalue('jobid') if 'getvalue' in form else form
        if(not jobid): #jobid is reative path to jo dir
            raise AttributeError("rmdir: 'jobid' attribute missing!")
        jobdir = joinp(datadir, jobid, d=datadir) #confinment check
        jobfile = os.path.join(jobdir, Metadata.FILE)
        if(not os.path.isdir(jobdir) or not os.path.isfile(jobfile)):
            raise IOError("Job not found: "+jobid)
        return jobid

    #remove data dir from library
    def post_rmdir(self, form):
        jobid = self.check_id(form)
        job_queue.terminate(jobid)
        dirpath = joinp(datadir, jobid, d=datadir) #confinment check
        shutil.rmtree(dirpath)
        self.sendOK('Deleted: '+jobid)

    #kill a running job
    def post_terminate(self, form):
        jobid = self.check_id(form)
        job_queue.terminate(jobid)
        md = Metadata(jobid) #check result
        if(md['status'] in (Job.QUEUED, Job.RUNNING)):
            md.update('status','-15')
        self.sendOK('Terminated: '+jobid)
        
    #restart a terminated job
    def post_restart(self, form):
        jobid = self.check_id(form)
        Job(jobid)
        self.sendOK('Resumed: '+jobid)

    #handle POST request
    def do_POST(self):
        try:
            form = cgi.FieldStorage(fp = self.rfile, headers = self.headers, environ={'REQUEST_METHOD': 'POST'})
            action = form.getvalue('action', '')
            logging.debug("POST: %s" % action)

            if not action:
                raise AttributeError("request type missing")
            getattr(self, "post_%s" % action)(form) #run the request

        except IOError as e:
            if hasattr(e, 'reason'): self.sendError(404, "URL does not exist. %s" % e.reason, action)
            else: self.sendError(404, str(e), action)
        except shutil.Error as why:
            self.sendError(501,"File operation failed: %s" % why)
        except OSError as e:
            self.sendError(501,"System error. %s" % e.strerror, action)
        except AttributeError as e:
            self.sendError(501, "Invalid POST request. %s" % e, action)
        except Exception as e:
            logging.exception("Runtime error in POST request: %s" % e)

#class for handling metadata files in job directories
class Metadata(object):
    FILE = "job.json"

    def __init__(self, jobid, filename=FILE):
        
        if not jobid:
            raise IOError('Metadata: no jobID given')
        self.jobid = jobid #self.key not part of metadata
        self.jobdir = joinp(datadir, jobid)
        if not os.path.isdir(self.jobdir):
            raise IOError('Metadata: invalid jobdir: '+jobid)
        self.md_file = os.path.join(self.jobdir, filename)
        if not os.path.exists(self.md_file):
            raise IOError('Metadata: '+filename+' missing from jobdir: '+jobid)
        
        try:
            self.metadata = json.load(open(self.md_file))
        except ValueError:
            try:
                os.rename(self.md_file, self.md_file+".corrupted")
                logging.error("Renamed corrupt metadata file: "+self.md_file)
            except OSError as e:
                logging.error("Corrupt metadata file renaming failed: "+e)
            self.metadata = {}
        
        self.logfile = os.path.join(self.jobdir, self["logfile"]) if self["logfile"] else ''
        self.stdout = os.path.join(self.jobdir, self["stdout"]) if self["stdout"] else ''
    
    def __getitem__(self, key) :
        try: return self.metadata[key]
        except KeyError:
            #logging.debug(self.jobdir+': no "'+key+'" in metadata!')
            return ""
    
    def __setitem__(self, key, value) :
        self.metadata[key] = value
    
    def __delitem__(self, key):
        try: del self.metadata[key]
        except KeyError: logging.debug(self.jobdir+': cannot delete "'+key+'" from metadata!')
    
    def __len__(self):
        return len(self.metadata)
    
    def __iter__(self):
        return iter(self.metadata)
    
    def __str__(self):
        return json.dumps(self.metadata)
    
    def strings(self):  #stringify all metadata values
        mdata = {}
        for k,v in self.metadata.items(): mdata[k] = str(v)
        return mdata
    
    def update(self, data, val=None):  #edit metadata
        if val is not None: #update single value
            self[data] = val
        else: #update multiple values
            if(type(data) is not dict):
                logging.error("Unvalid value (%s) passed to Metadata.update: %s" % (type(data), data))
                return
            for k in data:
                if data[k] is not None: self[k] = data[k]
        self.flush() #write to datafile
    
    def replace(self, data):  #replace metadata
        if(type(data) is dict):
            self.metadata = data
            self.flush()
    
    def flush(self):  #write metadata to file
        datafile = tempfile.NamedTemporaryFile(suffix=os.path.basename(self.md_file), prefix='', dir=self.jobdir, delete=False)
        json.dump(self.metadata, datafile, indent=2)
        datafile.close()
        os.chmod(datafile.name, 0o664)
        os.rename(datafile.name, self.md_file)
    
    def update_log(self):  #add log output to metadata object
        if not job_queue.get(self["id"]) and self["status"] in (Job.INIT, Job.QUEUED, Job.RUNNING): #broken job
            self.update("status", Job.FAIL) #update datafile
        self["log"] = self.last_log_line() #not written to datafile
        try:
            self["updated"] = int(os.stat(os.path.join(self.jobdir, self["stdout"])).st_mtime)
        except OSError:
            self["updated"] = int(time.time())
    
    def last_log_line(self): #read last line from the log file
        fpath = self.logfile or self.stdout
        try:
            if(not os.path.isfile(fpath) or not os.path.getsize(fpath)):
                if(fpath is self.logfile): fpath = self.stdout
                else: return ''
            logfile = open(fpath)
        except (OSError, IOError):
            return ''
        
        lastLine = ''
        try:
            for line in logfile:
                lastLine = line
            json.dumps(lastLine) #test if serializable
            lastLine = lastLine.strip().replace(self.jobdir, "jobPath") #remove full path
        except (TypeError, UnicodeDecodeError): #not a text file
            lastLine = ''
        logfile.close()
        return lastLine
    
    @classmethod
    def create(cls, dirpath, filename=FILE, name="unnamed"):
        if not dirpath:
            raise IOError('Metadata: create(): dirpath missing!')
        md = {
            "id": os.path.basename(dirpath),
            "name": name,
            "created": int(time.time()),
            "status": Job.INIT,
            "stdout": "output.log",
            "logfile": "err.log",
        }
        fpath = joinp(datadir, dirpath, filename)
        with open(fpath, 'w') as mdfile:
            mdfile.write(json.dumps(md, indent=2))
        os.chmod(fpath, 0o664)
        return cls(dirpath, filename) #cls=Metadata()

#class for creating queued jobs
class Job(object):
    INIT, QUEUED, RUNNING, SUCCESS, FAIL, TERMINATED = [1, 1, 2, 0, -1, -15]

    def __init__(self, jobid):
        
        md = Metadata(jobid)
        self.jobid = jobid
        self.jobdir = md.jobdir
        self.items = md.metadata
        
        self.errormsg = {
            -1  : "See log file",
            -11 : "Segmentation fault",
            -15 : "Terminated by user",
            -16 : "Terminated because of server restart",
            127 : "Executable not found"
        }
        
        self.job_status = self["status"] = Job.INIT
        self.lock = threading.Lock()
        self.bin = self["program"] #.bin keeps full dirpath
        self.popen = None
        self.postprocess = None
        
        self["updated"] = int(time.time())
        if(not self["infiles"]): del self["infiles"]
        
        #validate plugin file(s)
        plugins = self["plugin"].split('|') #pipes: plugin1|plugin2
        for plugin in plugins:
            pluginfile = joinp(plugindir, plugin, d=plugindir)
            if(not os.path.isfile(pluginfile)): raise IOError('Invalid plugin file: '+plugin)
        
        #add path to program(s)
        self.bin = '|'.join([self.check_exec(plugin, program) for program in self.bin.split('|')])

        #windows: replace path separators in params
        if(os.sep != '/'):
            params = [p.split(' ') for p in self["parameters"].split('|')]
            for i, param in enumerate(params):
                param = re.sub(r'(^|/|\|)\.\./', '\1..\\', param)
                params[i] = param
            self["parameters"] = ' '.join(self.params)

        self.update() #update datafile
        job_queue.enqueue(jobid, self) #add job to the queue
    
    def check_exec(self, plugin, program): #check the program path in the plugin dir
        pdir = os.path.dirname(os.path.join(plugindir, plugin))
        osdir = { #check path: plugin/[osx|linux|windows|.]/program
            'darwin': 'osx',
            'linux': 'linux',
            'win': 'windows',
            '': '' #fallback
        }

        def is_exec(fpath):
            return os.path.isfile(fpath) and os.access(fpath, os.X_OK)

        for osname in osdir:
            binpath = os.path.join(pdir, osname, program)
            if is_exec(binpath): return binpath
        return program #not found inside the plugin folder
    
    def __getitem__(self, key):
        try: return self.items[key]
        except KeyError: return ""
    
    def __setitem__(self, key, value) :
        self.items[key] = value
    
    def __delitem__(self, key):
        try: del self.items[key]
        except KeyError: pass
    
    def fullpath(self, filename):
        return os.path.join(self.jobdir, filename)
    
    def status(self, newstatus=None, end=False):
        if newstatus is not None:
            self.job_status = self["status"] = newstatus
            if end and newstatus != 0: #bad exit code
                try:
                    self["status"] = self.errormsg[newstatus]
                except KeyError:
                    self["status"] = "Error. Exit code: "+str(newstatus)
        return self.job_status
    
    def lock_status(self): self.lock.acquire()
    
    def unlock_status(self): self.lock.release()
    
    def terminate(self, shutdown=False):
        self.lock_status()
        if self.popen is not None: self.popen.terminate()
        self.status(Job.TERMINATED, end=True)
        if shutdown: self["status"] = self.errormsg[-16]
        self.update()
        logging.debug("Job "+self["id"]+" terminated.")
        self.unlock_status()
    
    def check_outfiles(self):
        try: #remove empty stdout/stderr files
            if(not os.path.getsize(self.fullpath(self["logfile"]))):
                os.remove(self.fullpath(self["logfile"]))
                del self["logfile"]
            if(not os.path.getsize(self.fullpath(self["stdout"]))):
                os.remove(self.fullpath(self["stdout"]))
                del self["stdout"]
        except OSError: pass
        #verify output filenames
        outfiles = self["outfiles"].split(',')
        for i, filename in enumerate(outfiles):
            if(not os.path.isfile(self.fullpath(filename))):
                del outfiles[i]
        if(len(outfiles)):
            self["outfiles"] = ','.join(outfiles)
        else:
            del self["outfiles"]
        

    def done(self):
        return self["status"] not in (Job.INIT, Job.QUEUED, Job.RUNNING)
    
    def begin(self):
        self.status(Job.RUNNING)
        self.update()

    def process(self):
        self.lock_status()
        
        if self.done():
            self.unlock_status()
            return
        
        self.begin()
        
        #set limits for system resources
        if(not sys.platform.startswith("win")):
            try: #setrlimit(type, (sortlimit, hardlimit)); process = server request thread with Popen children 
                if(cpulimit): resource.setrlimit(resource.RLIMIT_CPU, (cpulimit*3600, cpulimit*3600)) #limit running time
                if(filelimit): resource.setrlimit(resource.RLIMIT_FSIZE, (filelimit, filelimit)) #limit output file size
                resource.setrlimit(resource.RLIMIT_NOFILE, (1000, 1000)) #limit nr. of files created by the process
            except (ValueError, resource.error) as e:
                logging.debug("Failed to limit job resources: "+str(e))
            os.nice(5) #lower process priority
        
        #separate piped commands & params
        programs = self.bin.split('|')
        plen = len(programs)
        params = self["parameters"].split('|')
        if(not plen or plen != len(params)):
            raise IOError("Malformed pipeline command (wrong length)")

        outfile = open(self.fullpath(self["stdout"]), "wb")
        errfile = open(self.fullpath(self["logfile"]), "w")
        #prevent job to inherit all parent filehandlers (buggy on windows)
        closef = False if sys.platform.startswith("win") else True

        #start the job with a single or multiple (piped) commands
        try:
            logging.debug("Launching new job in "+self.jobdir)
            for i, program in enumerate(programs):
                command = shlex.split(program+' '+params[i])
                logging.debug("Job command: "+' '.join(command))
                last = i is plen-1
                if i is 0:
                    p1 = Popen(command, stdout = PIPE if plen > 1 else outfile, stderr = errfile, close_fds = closef, cwd = self.jobdir)
                else:
                    p2 = Popen(command, stdin = p1.stdout, stdout = outfile if last else PIPE, stderr = errfile, close_fds = closef, cwd = self.jobdir)
                    p1.stdout.close() #detach pipe from parent (fix SIGPIPE forwarding)
                    p1 = p2
            
            self.popen = p1
        except OSError as e:
            logging.debug("Job command failed: "+str(e))
            errfile.write("Server error: "+str(e)+" when executing job: "+command)
            self.unlock_status()
            ret = -1
        else:
            self.unlock_status()
            ret = self.popen.wait()
        finally:
            self.lock_status()
            self.end(ret)
            outfile.close()
            errfile.close()
            self.unlock_status()

    def end(self, rc):
        if self.done(): return
        self["completed"] = int(time.time())
        self.status(rc, end=True)
        if(rc == 0): #job completed
            self.check_outfiles()
            if(self["nextstep"]):
                Job(self["nextstep"]) #run the next step
            elif(self["notify"]): #send notification email
                del self["notify"]
                if('firstid' in self.items):
                    send_job_done(self.items.firstid)
        self.flush()
    
    def update(self, key="", value=""): #edit metadata and write out
        if(key and value): self[key] = value
        Metadata(self["id"]).update(self.items)
    
    def flush(self): #write metadata to file
        Metadata(self["id"]).replace(self.items)

#class for creating the job queue
class Workqueue(object):
    def __init__(self, numworkers=0, qtimeout=1, qsize=0):
        self.jobs = {}
        self.queue = queue.Queue(qsize)
        self.workthreads = self._init_workers(numworkers)
        self.qtimeout = qtimeout
        self.running = False
    
    def _init_workers(self, numworkers):
        if numworkers == 0 :
            numworkers = multiprocessing.cpu_count()
        tmp = []
        
        for tnum in range(numworkers):
            t = threading.Thread(target=self._consume_queue)
            t.daemon = True
            tmp.append(t)
        return tmp
    
    def start(self):
        self.running = True
        for t in self.workthreads:
            t.start()
        logging.debug("Workqueue: started")
    
    def stop(self):
        self.running = False
        for jobid in self.jobs.keys():
            self.terminate(jobid, shutdown=True)
        self.queue.join()
        for t in self.workthreads:
            t.join()
        logging.debug("Workqueue: stopped")
    
    def enqueue(self, jobid, job):
        logging.debug("Workqueue: enqueuing %s" % jobid)
        self.jobs[jobid] = job
        self.queue.put(job)
        job.status(Job.QUEUED)
        job.update()
    
    def get(self, jobid):
        try :
            return self.jobs[jobid]
        except KeyError:
            #logging.debug("Workqueue: %s not queued" % jobid)
            return None
    
    def terminate(self, jobid, shutdown=False):
        if jobid in self.jobs:
            self.get(jobid).terminate(shutdown)
            del self.jobs[jobid]
            self.queue.task_done()
            logging.debug("Workqueue: terminated %s" % jobid)
    
    def _consume_queue(self):
        while self.running:
            try :
                job = self.queue.get(timeout=self.qtimeout)
            except queue.Empty:
                continue
            
            jobid = job["id"]
            logging.debug("Workqueue: starting %s" % jobid)
            
            try:
                job.process()
            except OSError:
                raise
            
            if jobid in self.jobs:
                del self.jobs[jobid]
                self.queue.task_done()
                logging.debug("Workqueue: completed %s (status: %s)" % (jobid, job.status()))


#HTTP server subclass for multithreading
class MultiThreadServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True #allow restart after dirty close
    
    def __init__(self, *args):
        HTTPServer.__init__(self, *args)
    
    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
            self.close_request(request)
        except socket.error:
            logging.debug('Disconnected request from '+str(client_address))  


#Start pline server
def main():
    global serverport
    global debug
    global logtofile
    global local
    global job_queue
    global openbrowser
    global osxbundle
    
    parser = argparse.ArgumentParser(description="Backend server for Pline webapp.")
    parser.add_argument("-p", "--port", type=int, metavar="N", help="set server port (default: %s)" % serverport, default=serverport)
    vgroup = parser.add_mutually_exclusive_group()
    vgroup.add_argument("-v", "--verbose", action='store_true', help="show server traffic %s" % ("(default)" if debug else ""), default=debug)
    vgroup.add_argument("-q", "--quiet", action='store_true', help="minimal feedback %s" % ("(default)" if not debug else ""))
    fgroup = parser.add_mutually_exclusive_group()
    fgroup.add_argument("-f", "--filelog", action='store_true', help="print feedback to file %s" % ("(default)" if logtofile else ""), default=logtofile)
    fgroup.add_argument("-c", "--console", action='store_true', help="print feedback to console %s" % ("(default)" if not logtofile else ""))
    lgroup = parser.add_mutually_exclusive_group()
    lgroup.add_argument("-l", "--local", action='store_true', help="autolaunch web browser %s" % ("(default)" if local else ""), default=local)
    lgroup.add_argument("-r", "--remote", action='store_true', help="just start the server %s" % ("(default)" if not local else ""))
    args = parser.parse_args()
    serverport = args.port
    debug = False if args.quiet else args.verbose
    logtofile = False if args.console else args.filelog
    local = False if args.remote else args.local
    start_logging()
    
    info('Starting server...\n')
    job_queue = Workqueue(num_workers) #start task queue
    job_queue.start()
    
    try:
        server = MultiThreadServer(('',serverport), plineServer)
        info("Pline HTTP server started at port %d\n" % serverport)
        if(not osxbundle): info("Press CRTL+C to stop the server.\n")
        logging.debug('Serving from: %s' % plinedir)
        logging.debug('Hostname: %s' % socket.getfqdn()) #get server hostname
        
        if(local and openbrowser): #autolaunch Pline in a webbrowser
            try: webbrowser.open("http://localhost:%d" % serverport)
            except webbrowser.Error as e: logging.error("Failed to open a web browser: %s" % e)
        server.serve_forever()
    except socket.error as e :
        logging.error(e)
        return -1
    except KeyboardInterrupt:
        info("\nShutting down server...")
        server.socket.close()
    except Exception as e:
        logging.exception("Runtime error: %s" % e)
    
    if(len(job_queue.jobs)):
        info("Warning: %s jobs in the queue were cancelled." % len(job_queue.jobs))
    job_queue.stop()
    return 0

if __name__ == '__main__': #when run as script
    sys.exit(main()) #run & give return code
