var fs = require("fs"),
    csv = require("dsv")(",");

module.exports = {
  read: function(filename,cb) {
    fs.readFile(filename,"utf8",function(err,raw){

      if (err) {
        throw new Error(err);
      }

      cb(csv.parse(raw));

    });
  },
  //Write to a temp file and rename it into place, so a crash or kill
  //mid-write never leaves a truncated output file behind
  write: function(filename,rows,cb) {
    var tmp = filename + ".tmp";
    fs.writeFile(tmp,csv.format(rows),function(err){
      if (err) {
        throw new Error(err);
      };
      fs.rename(tmp,filename,function(err){
        if (err) {
          throw new Error(err);
        }
        cb();
      });
    });
  },
  writeSync: function(filename,rows) {
    var tmp = filename + ".tmp";
    fs.writeFileSync(tmp,csv.format(rows));
    fs.renameSync(tmp,filename);
  },
  parse: csv.parse,
  stringify: csv.format
};