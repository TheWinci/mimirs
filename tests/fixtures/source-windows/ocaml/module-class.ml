module Report = struct
  type entry = {
    title : string;
    owner : string option;
  }

  class report_book = object
    val mutable entries : entry list = []

    method add title owner =
      entries <- entries @ [{ title; owner }]

    method render =
      List.map
        (fun entry ->
          let owner = Option.value entry.owner ~default:"unassigned" in
          entry.title ^ " — " ^ owner)
        entries

    method size = List.length entries
  end
end
