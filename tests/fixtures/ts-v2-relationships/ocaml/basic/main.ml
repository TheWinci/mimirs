module Alias = App.Service
open Worker

let launch value = Alias.execute value
let direct value = Worker.run value
let missing value = Missing.run value
